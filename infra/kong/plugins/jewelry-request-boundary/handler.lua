local uuid = require "kong.tools.uuid".uuid
local cjson = require "cjson.safe"

local Boundary = { VERSION = "0.1.0", PRIORITY = 100002 }
local CODES = {
  [400] = "VALIDATION_FAILED", [401] = "INVALID_TOKEN", [403] = "FORBIDDEN",
  [404] = "NOT_FOUND", [413] = "PAYLOAD_TOO_LARGE", [429] = "RATE_LIMITED",
  [500] = "INTERNAL_ERROR", [502] = "SERVICE_UNAVAILABLE",
  [503] = "SERVICE_UNAVAILABLE", [504] = "SERVICE_UNAVAILABLE",
}

local function valid_uuid(id)
  if type(id) ~= "string" or #id ~= 36 then return false end
  if id:sub(9, 9) ~= "-" or id:sub(14, 14) ~= "-" or
      id:sub(19, 19) ~= "-" or id:sub(24, 24) ~= "-" then return false end
  local hex = id:gsub("%-", "")
  return #hex == 32 and hex:match("^%x+$") ~= nil
end

local function correlation_id()
  local id = kong.request.get_header("x-correlation-id")
  return valid_uuid(id) and id or uuid()
end

function Boundary:access()
  local id = correlation_id()
  if kong.request.get_header("x-correlation-id") ~= id then
    -- The bundled correlation-id plugin reads the downstream request header.
    ngx.req.set_header("x-correlation-id", id)
    kong.service.request.set_header("x-correlation-id", id)
  end

  for name in pairs(kong.request.get_headers(1000)) do
    local lower = name:lower()
    if lower:sub(1, 7) == "x-user-" or lower == "x-role" or
        lower == "x-branch-id" or lower:sub(1, 11) == "x-consumer-" or
        lower:sub(1, 13) == "x-credential-" then
      kong.service.request.clear_header(name)
    end
  end

  -- Kong only trusts the two static Nginx peers configured in trusted_ips.
  -- Replace any client supplied chain before proxying to business services.
  local ip = kong.client.get_forwarded_ip()
  kong.service.request.clear_header("x-real-ip")
  kong.service.request.set_header("x-forwarded-for", ip)
end

function Boundary:header_filter()
  if kong.response.get_source() == "service" then return end
  local id = correlation_id()
  ngx.req.set_header("x-correlation-id", id)
  kong.response.set_header("x-correlation-id", id)
  local status = kong.response.get_status()
  if not CODES[status] then return end
  kong.ctx.shared.jewelry_error = { status = status, id = id, chunks = {} }
  kong.response.set_header("content-type", "application/json; charset=utf-8")
  kong.response.clear_header("content-length")
end

function Boundary:body_filter()
  local state = kong.ctx.shared.jewelry_error
  if not state then return end
  if ngx.arg[1] then state.chunks[#state.chunks + 1] = ngx.arg[1] end
  ngx.arg[1] = nil
  if not ngx.arg[2] then return end
  local existing = cjson.decode(table.concat(state.chunks))
  local code = CODES[state.status]
  if type(existing) == "table" and existing.code == "TOKEN_EXPIRED" and state.status == 401 then
    code = "TOKEN_EXPIRED"
  end
  local message = ({
    TOKEN_EXPIRED = "Token đã hết hạn",
    INVALID_TOKEN = "Token không hợp lệ",
    PAYLOAD_TOO_LARGE = "Nội dung vượt quá 1048576 byte",
    RATE_LIMITED = "Quá nhiều lần thử, vui lòng thử lại sau",
    SERVICE_UNAVAILABLE = "Dịch vụ tạm thời không sẵn sàng, vui lòng thử lại sau",
    INTERNAL_ERROR = "Hệ thống gặp lỗi, vui lòng thử lại sau",
  })[code] or (type(existing) == "table" and existing.message) or "Not Found"
  ngx.arg[1] = cjson.encode({ code = code, message = message, correlationId = state.id })
end

return Boundary

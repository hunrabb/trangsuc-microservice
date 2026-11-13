local cjson = require "cjson.safe"

-- Same single-instance, in-memory limits as the existing NestJS gateway.
local Rate = { VERSION = "0.1.0", PRIORITY = 1200 }
local dict = ngx.shared.jewelry_limits

local function add(limits, key, count, seconds)
  limits[#limits + 1] = { key = key, count = count, seconds = seconds }
end

local function starts_path(path, prefix)
  return path == prefix or path:sub(1, #prefix + 1) == prefix .. "/"
end

local function email_of_body()
  local body = kong.request.get_raw_body()
  if type(body) ~= "string" then return "" end
  local json = cjson.decode(body)
  if type(json) ~= "table" or type(json.email) ~= "string" then return "" end
  return json.email:match("^%s*(.-)%s*$"):lower()
end

local function user_of_verified_token()
  local token = kong.ctx.shared.authenticated_jwt_token
  if type(token) ~= "string" then return nil end
  local encoded = token:match("^[^.]+%.([^.]+)%.")
  if not encoded then return nil end
  local value = encoded:gsub("-", "+"):gsub("_", "/")
  value = value .. string.rep("=", (4 - #value % 4) % 4)
  local claims = cjson.decode(ngx.decode_base64(value) or "")
  return type(claims) == "table" and type(claims.sub) == "string" and claims.sub or nil
end

function Rate:access(config)
  local method = kong.request.get_method()
  local path = kong.request.get_path():lower():gsub("/+$", "")
  local ip = kong.client.get_forwarded_ip() or ""
  local kind = config.kind
  local limits = {}

  if kind == "catalog-and-orders" then
    if (method == "GET" or method == "HEAD") and starts_path(path, "/api/shop/products") then
      add(limits, "catalog:ip:" .. ip, 120, 60)
    end
    if starts_path(path, "/api/shop/orders") then
      if method == "POST" then add(limits, "checkout:ip:" .. ip, 10, 60)
      elseif method == "GET" or method == "HEAD" then
        add(limits, "online-order:ip:" .. ip, 120, 60)
      end
    end
  elseif kind == "my-orders" then
    if method == "POST" then add(limits, "checkout:ip:" .. ip, 10, 60)
    elseif method == "GET" or method == "HEAD" then
      add(limits, "online-order:ip:" .. ip, 120, 60)
    end
  elseif kind == "payments" then
    local payment = path:match("^(/api/admin/sales/branches/[^/]+/online%-orders/[^/]+/payments)")
    if method == "POST" and payment and starts_path(path, payment) then
      add(limits, "payment-admin:ip:" .. ip, 20, 60)
    end
  elseif method == "POST" then
    if kind == "login" then
      local email = email_of_body()
      add(limits, "login:ip+email:" .. ip .. ":" .. ngx.md5(email), 5, 60)
      add(limits, "login:ip:" .. ip, 20, 60)
    elseif kind == "google" then add(limits, "google:ip:" .. ip, 20, 60)
    elseif kind == "refresh" then add(limits, "refresh:ip:" .. ip, 60, 60)
    elseif kind == "change-password" then
      local user = user_of_verified_token()
      if user then add(limits, "change-password:user:" .. user, 5, 900) end
      add(limits, "change-password:ip:" .. ip, 20, 60)
    end
  end

  local retry_after = 0
  for _, limit in ipairs(limits) do
    local value, err = dict:incr(limit.key, 1, 0, limit.seconds)
    if not value then
      kong.log.err("rate-limit counter failed: ", err)
      return kong.response.exit(503, { code = "SERVICE_UNAVAILABLE", message = "Dịch vụ tạm thời không sẵn sàng, vui lòng thử lại sau", correlationId = kong.request.get_header("x-correlation-id") })
    end
    if value > limit.count then
      retry_after = math.max(retry_after, math.ceil(dict:ttl(limit.key) or 1), 1)
    end
  end
  if retry_after > 0 then
    return kong.response.exit(429, {
      code = "RATE_LIMITED",
      message = "Quá nhiều lần thử, vui lòng thử lại sau",
      correlationId = kong.request.get_header("x-correlation-id"),
    }, { ["retry-after"] = tostring(retry_after) })
  end
end

return Rate

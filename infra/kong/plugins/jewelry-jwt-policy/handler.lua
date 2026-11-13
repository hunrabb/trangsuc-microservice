local cjson = require "cjson.safe"

local Policy = { VERSION = "0.1.0", PRIORITY = 1400 }
local CLOCK_SKEW_SECONDS = 30
local MAX_TOKEN_LENGTH = 8192

local function reject(code, message)
  -- correlation-id plugin chạy trước policy và đã đặt header này trên request.
  local id = kong.request.get_header("x-correlation-id") or ngx.var.request_id
  return kong.response.exit(401, {
    code = code,
    message = message,
    correlationId = id,
  }, { ["x-correlation-id"] = id })
end

local function invalid()
  return reject("INVALID_TOKEN", "Token không hợp lệ")
end

local function payload_of(token)
  local encoded = token:match("^[A-Za-z0-9_-]+%.([A-Za-z0-9_-]+)%.[A-Za-z0-9_-]+$")
  if not encoded then return nil end
  local base64 = encoded:gsub("-", "+"):gsub("_", "/")
  base64 = base64 .. string.rep("=", (4 - #base64 % 4) % 4)
  local decoded = ngx.decode_base64(base64)
  if not decoded then return nil end
  local claims = cjson.decode(decoded)
  if type(claims) ~= "table" then return nil end
  return claims
end

-- The built-in JWT plugin (priority 1450) must have authenticated the same
-- Authorization token before this policy reads any claims. Do not enable an
-- anonymous Consumer or another authentication plugin on protected routes.
function Policy:access(config)
  local credential = kong.client.get_credential()
  local verified = kong.ctx.shared.authenticated_jwt_token
  local authorization = kong.request.get_header("authorization")
  if type(authorization) ~= "string" or type(verified) ~= "string" or
      #verified > MAX_TOKEN_LENGTH or not credential or credential.key ~= config.issuer then
    return invalid()
  end
  local presented = authorization:match("^[Bb][Ee][Aa][Rr][Ee][Rr] +(%S+)$")
  if presented ~= verified then return invalid() end

  local claims = payload_of(verified)
  if not claims or claims.iss ~= config.issuer or
      claims.aud ~= config.audience or
      type(claims.sub) ~= "string" or
      type(claims.exp) ~= "number" or claims.exp % 1 ~= 0 then
    return invalid()
  end

  local now = ngx.time()
  if claims.exp <= now - CLOCK_SKEW_SECONDS then
    return reject("TOKEN_EXPIRED", "Token đã hết hạn")
  end
  if claims.nbf ~= nil and (type(claims.nbf) ~= "number" or
      claims.nbf % 1 ~= 0 or claims.nbf > now + CLOCK_SKEW_SECONDS) then
    return invalid()
  end
end

return Policy

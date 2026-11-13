local Guard = { VERSION = "0.1.0", PRIORITY = 100000 }

local function reject()
  local id = kong.request.get_header("x-correlation-id")
  return kong.response.exit(404, {
    code = "NOT_FOUND",
    message = "Not Found",
    correlationId = id,
  }, { ["x-correlation-id"] = id })
end

local function safe_segments(path)
  if path:sub(1, 1) ~= "/" or path:find("//", 1, true) then return false end
  for segment in path:gmatch("[^/]+") do
    if segment:gsub("%%[%x][%x]", ""):find("%%", 1, true) then return false end
    local decoded = ngx.unescape_uri(segment)
    if decoded == "." or decoded == ".." or decoded:find("[/\\%z]") or
        decoded:find("%%", 1, true) then return false end
  end
  return true
end

function Guard:access(config)
  local raw = kong.request.get_raw_path()
  -- Kong normalizes URI before matching. Reject ambiguous spellings instead of
  -- allowing normalization to choose a less protected route.
  if not safe_segments(raw) then return reject() end
  local prefix = config.prefix
  if raw:sub(1, #prefix):lower() ~= prefix:lower() then return reject() end
  local remainder = raw:sub(#prefix + 1)
  if remainder ~= "" and remainder:sub(1, 1) ~= "/" then return reject() end
  if config.exact and remainder ~= "" and remainder ~= "/" then return reject() end
  local first = remainder:match("^/([^/]*)")
  if first then first = ngx.unescape_uri(first) end
  if first and (first:lower() == "internal" or first:lower() == "health") then
    return reject()
  end
end

return Guard

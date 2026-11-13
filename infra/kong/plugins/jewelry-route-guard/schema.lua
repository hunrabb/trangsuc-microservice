return {
  name = "jewelry-route-guard",
  fields = {
    { consumer = { type = "foreign", reference = "consumers", required = false } },
    { protocols = { type = "set", elements = { type = "string", one_of = { "http", "https" } }, default = { "http", "https" } } },
    { config = { type = "record", fields = {
      { prefix = { type = "string", required = true } },
      { exact = { type = "boolean", default = false } },
    } } },
  },
}

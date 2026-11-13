return {
  name = "jewelry-request-boundary",
  fields = {
    { consumer = { type = "foreign", reference = "consumers", required = false } },
    { protocols = { type = "set", elements = { type = "string", one_of = { "http", "https" } }, default = { "http", "https" } } },
    { config = { type = "record", fields = {} } },
  },
}

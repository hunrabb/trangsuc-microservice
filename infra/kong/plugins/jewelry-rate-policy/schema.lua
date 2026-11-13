return {
  name = "jewelry-rate-policy",
  fields = {
    { consumer = { type = "foreign", reference = "consumers", required = false } },
    { protocols = { type = "set", elements = { type = "string", one_of = { "http", "https" } }, default = { "http", "https" } } },
    { config = { type = "record", fields = {
      { kind = { type = "string", required = true, one_of = {
        "login", "google", "refresh", "change-password", "catalog-and-orders", "my-orders", "payments",
      } } },
    } } },
  },
}

FROM kong:3.9.4
USER root
COPY plugins/jewelry-jwt-policy /usr/local/share/lua/5.1/kong/plugins/jewelry-jwt-policy
COPY plugins/jewelry-request-boundary /usr/local/share/lua/5.1/kong/plugins/jewelry-request-boundary
COPY plugins/jewelry-route-guard /usr/local/share/lua/5.1/kong/plugins/jewelry-route-guard
COPY plugins/jewelry-rate-policy /usr/local/share/lua/5.1/kong/plugins/jewelry-rate-policy
USER kong

# No build stage: the repo root IS the deployable. index.html, bricks.html
# and asteroids.html are fully self-contained single files (no npm, no
# bundler, no post-processing) — packaging is a copy, nothing else.
FROM caddy:latest
COPY index.html bricks.html asteroids.html /srv/
COPY <<'EOF' /etc/caddy/Caddyfile
:80 {
    root * /srv
    file_server
    encode gzip
}
EOF
EXPOSE 80
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]

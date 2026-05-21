#!/bin/sh

# If API_URL is explicitly set, inject it into the frontend
# If not set, replace the hardcoded Railway URL with empty string
# so the app uses same-origin requests via the Nginx reverse proxy
if [ -n "$API_URL" ]; then
  sed -i "s|window.API_URL || 'https://capacity-planner-production-1cf7.up.railway.app'|window.API_URL || '${API_URL}'|g" /usr/share/nginx/html/index.html
else
  sed -i "s|window.API_URL || 'https://capacity-planner-production-1cf7.up.railway.app'|window.API_URL || ''|g" /usr/share/nginx/html/index.html
fi

exec "$@"

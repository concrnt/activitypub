#!/bin/sh
# runs after install and after upgrade (deb: configure, rpm: 1 or 2)
set -e

if ! getent group concrnt-ap-bridge >/dev/null; then
    groupadd --system concrnt-ap-bridge
fi
if ! getent passwd concrnt-ap-bridge >/dev/null; then
    useradd --system --gid concrnt-ap-bridge --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin --comment "concrnt ActivityPub bridge" concrnt-ap-bridge
fi

# config holds the service account private key: readable by the service user only
chown -R root:concrnt-ap-bridge /etc/concrnt-ap-bridge
chmod 750 /etc/concrnt-ap-bridge
find /etc/concrnt-ap-bridge -type f -exec chmod 640 {} +

if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload >/dev/null 2>&1 || true
    # pick up the new code if the service is already running (upgrade)
    systemctl try-restart concrnt-ap-bridge.service >/dev/null 2>&1 || true
fi

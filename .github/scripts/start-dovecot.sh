#!/usr/bin/env bash
#
# Start the two Dovecot containers the mail integration suite runs against
# (packages/api/src/test/mail-integration.test.ts).
#
# Why a step and not a `services:` entry: Dovecot needs configuration files,
# and a workflow's service containers are created BEFORE the workspace is
# checked out -- there is nothing to bind-mount at the moment they start. So
# the config and a self-signed certificate are written to the runner's temp
# directory here, and the containers are started with `docker run -v`.
#
# Mailpit has no such problem and stays in `services:`: it generates its own
# self-signed certificate from MP_SMTP_TLS_CERT=sans:..., so it needs env vars
# and no files at all.
#
# TWO Dovecots, because one server cannot be both halves of the STARTTLS test:
#   conduit-dovecot            993 (IMAPS) + 1144 (IMAP, offers STARTTLS)
#   conduit-dovecot-nostarttls 1143 (IMAP, ssl = no, offers NO STARTTLS)
# The second exists so the suite can prove that requiring STARTTLS FAILS
# against a server that does not offer it, rather than quietly continuing in
# the clear with the password.
set -euo pipefail

IMAGE="dovecot/dovecot:2.3-latest"
TMP="${RUNNER_TEMP:-/tmp}"
MAIN="$TMP/conduit-dovecot"
PLAIN="$TMP/conduit-dovecot-nostarttls"

MAIL_USER="${MAIL_IT_USERNAME:-conduit@test.local}"
MAIL_PASS="${MAIL_IT_PASSWORD:-testpass}"

rm -rf "$MAIN" "$PLAIN"
mkdir -p "$MAIN" "$PLAIN"

# Self-signed, one day, CN/SAN localhost. Deliberately untrusted: "does
# MAIL_TLS_REJECT_UNAUTHORIZED=0 actually reach the socket" is one of the
# things the suite proves, and it needs a certificate Node would otherwise
# refuse.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout "$MAIN/tls.key" -out "$MAIN/tls.crt" \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

# The container runs as root, so it can read these whatever their mode; 0644
# only removes the question from the failure list if that ever changes.
chmod 644 "$MAIN/tls.key" "$MAIN/tls.crt"

printf '%s:{PLAIN}%s\n' "$MAIL_USER" "$MAIL_PASS" > "$MAIN/users"
cp "$MAIN/users" "$PLAIN/users"
chmod 644 "$MAIN/users" "$PLAIN/users"

# --- The TLS instance ------------------------------------------------------
#
# /etc/dovecot is bind-mounted wholesale, so none of the image's own
# configuration is in play and this file is the entire story.
cat > "$MAIN/dovecot.conf" <<'CONF'
protocols = imap
listen = *

# The image ships /srv/mail owned by its own vmail user (uid/gid 1000).
mail_home = /srv/mail/%Lu
mail_location = maildir:~/Mail
mail_uid = 1000
mail_gid = 1000
first_valid_uid = 1000
last_valid_uid = 1000

passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u /etc/dovecot/users
}

userdb {
  driver = static
  args = uid=1000 gid=1000 home=/srv/mail/%Lu
}

# Dovecot's default is a two-second penalty on every rejected login. The suite
# asserts the adapter's "auth:" classification against a real rejection, and
# would otherwise pay that penalty for each such case.
auth_failure_delay = 0

ssl = yes
ssl_cert = </etc/dovecot/tls.crt
ssl_key = </etc/dovecot/tls.key

namespace inbox {
  inbox = yes
  separator = /

  # The ImapClient contract has no create-mailbox call -- nothing in the sync
  # engine needs one -- so every folder the suite writes to is auto-created
  # here instead. One per group of cases: that is how they stay independent of
  # each other without a delete the interface does not have either.
  mailbox Sent {
    special_use = \Sent
    auto = create
  }
  mailbox Walk {
    auto = create
  }
  mailbox Drop {
    auto = create
  }
  mailbox Flags {
    auto = create
  }
  mailbox Dates {
    auto = create
  }
  mailbox Big {
    auto = create
  }
}

protocol imap {
  # The suite holds several connections at once (an IDLE parked on INBOX plus
  # the one delivering to it, and so on). Dovecot's default of 10 is close
  # enough to that to be worth moving out of the way.
  mail_max_userip_connections = 100
}

service imap-login {
  process_min_avail = 1
  client_limit = 1000
  service_count = 0
  inet_listener imap {
    port = 143
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}

log_path = /dev/stdout
info_log_path = /dev/stdout
verbose_proctitle = yes
CONF

# --- The STARTTLS-less instance --------------------------------------------
#
# ssl = no, so this one never advertises STARTTLS. It is never logged into --
# the connection fails at the upgrade -- so it needs no mailboxes.
cat > "$PLAIN/dovecot.conf" <<'CONF'
protocols = imap
listen = *

mail_home = /srv/mail/%Lu
mail_location = maildir:~/Mail
mail_uid = 1000
mail_gid = 1000
first_valid_uid = 1000
last_valid_uid = 1000

passdb {
  driver = passwd-file
  args = scheme=PLAIN username_format=%u /etc/dovecot/users
}

userdb {
  driver = static
  args = uid=1000 gid=1000 home=/srv/mail/%Lu
}

ssl = no

service imap-login {
  process_min_avail = 1
  inet_listener imap {
    port = 143
  }
  inet_listener imaps {
    port = 0
  }
}

log_path = /dev/stdout
info_log_path = /dev/stdout
CONF

docker rm -f conduit-dovecot conduit-dovecot-nostarttls > /dev/null 2>&1 || true

docker run -d --name conduit-dovecot \
    -p 993:993 -p 1144:143 \
    -v "$MAIN:/etc/dovecot:ro" \
    "$IMAGE"

docker run -d --name conduit-dovecot-nostarttls \
    -p 1143:143 \
    -v "$PLAIN:/etc/dovecot:ro" \
    "$IMAGE"

# A rejected configuration kills Dovecot within a second of boot, and the
# message saying which line it objected to is only in the container's log. The
# alternative is finding out from a health-wait timeout two minutes later with
# nothing to read, so check here while the answer is still one command away.
sleep 3
for name in conduit-dovecot conduit-dovecot-nostarttls; do
    if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
        echo "$name exited immediately; its log follows:" >&2
        docker logs "$name" >&2 || true
        exit 1
    fi
done

echo "started conduit-dovecot (993, 1144) and conduit-dovecot-nostarttls (1143)"

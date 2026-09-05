#!/bin/bash

# Version string surfaced by the app at /api/health. Derived from the manifest
# version with the ~ynhN packaging suffix stripped.
# shellcheck disable=SC2034 # consumed by ynh_config_add's __APP_VERSION__ substitution, not referenced by name here
app_version="$(ynh_read_manifest 'version' | cut -d'~' -f1)"

# Create $install_dir/.env.oauth if it is not already there, as a commented
# template the operator fills in by hand.
#
# WHY A SECOND FILE AND NOT MORE LINES IN .env -- and this is a trap Task 4
# walked into before it found it. `.env` is a TEMPLATE: install and upgrade both
# end with `ynh_config_add --template=".env"`, which RE-RENDERS it from
# conf/.env. `ynh_setup_source --keep=".env"` preserves the operator's file
# through the source swap and then that render overwrites it two steps later. So
# an instruction to "add MAIL_OAUTH_MICROSOFT_CLIENT_ID to .env" is an
# instruction that works until the next upgrade and then silently un-works: the
# app boots, the registration is gone, and the Settings page stops offering the
# provider. Nothing would say why.
#
# The values cannot go INTO conf/.env either, because a template placeholder
# with no app setting behind it renders as the literal __MAIL_OAUTH_..._ID__ --
# a client id that is not empty, so config.ts reads it as a complete
# registration and the failure moves to a consent screen.
#
# Hence a file the packaging creates once and never rewrites. systemd loads it
# with `EnvironmentFile=-`, the leading dash meaning "carry on if it is absent",
# so an install that never touches it behaves exactly as before.
#
# THE SAME [ -f ] GUARD mail.key HAS, for a weaker version of the same reason:
# there is nothing unrecoverable about a client id, but rewriting an operator's
# edited file on every upgrade is the behaviour this whole arrangement exists to
# avoid, and a guard is cheaper than remembering that.
conduit_ensure_oauth_env() {
    local target="$install_dir/.env.oauth"
    if [ ! -f "$target" ]; then
        cat > "$target" <<'OAUTH_ENV'
# Conduit mail OAuth (Phase 8, v1.7.0). Optional: leave this file untouched and
# mail accounts sign in with a password, which is the ordinary case.
#
# THIS FILE IS NEVER REWRITTEN BY AN UPGRADE. That is the whole reason it is not
# part of .env, which is regenerated from a template every time.
#
# docs/mail-oauth-setup.md has the registration steps for each provider, what
# each value is, and the tenant-side switches that are not Conduit's to set.
# Restart after editing:  systemctl restart conduit
#
# The redirect URI is ONE value for both providers and is compared BYTE FOR BYTE
# at the provider (RFC 6749 3.1.2.3). It must be exactly what you registered
# there, and it must end in /api/mail/oauth/callback -- Conduit refuses to start
# otherwise, and names this setting when it does. The Settings > Mail page shows
# the exact string this install expects.
#MAIL_OAUTH_REDIRECT_URI=https://your.domain/path/api/mail/oauth/callback

# Microsoft: a single-tenant WEB app registration in your own Entra directory.
# The tenant is required -- there is deliberately no fallback to /common, which
# would authenticate against the wrong directory.
#MAIL_OAUTH_MICROSOFT_CLIENT_ID=
#MAIL_OAUTH_MICROSOFT_CLIENT_SECRET=
#MAIL_OAUTH_MICROSOFT_TENANT=

# Google: a Web application client in your own Google Cloud project. Read the
# Workspace-versus-consumer section of the docs BEFORE you use this with a
# personal @gmail.com address -- Google revokes the sign-in every 7 days while
# the app is in Testing.
#MAIL_OAUTH_GOOGLE_CLIENT_ID=
#MAIL_OAUTH_GOOGLE_CLIENT_SECRET=
OAUTH_ENV
    fi
    # Asserted rather than assumed, every run, exactly as .env's 400 is: this
    # file holds a client secret once the operator fills it in.
    chmod 400 "$target"
    chown "$app:$app" "$target"
}

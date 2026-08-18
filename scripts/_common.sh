#!/bin/bash

# Version string surfaced by the app at /api/health. Derived from the manifest
# version with the ~ynhN packaging suffix stripped.
# shellcheck disable=SC2034 # consumed by ynh_config_add's __APP_VERSION__ substitution, not referenced by name here
app_version="$(ynh_read_manifest 'version' | cut -d'~' -f1)"

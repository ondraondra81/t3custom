#!/bin/bash
# Upload credentials directly from the Mac to this fork's protected environment.
set +x
set -euo pipefail
umask 077

fail() { printf 'CHYBA: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -s)" == Darwin ]] || fail 'Spust tento skript na svem Macu.'
command -v gh >/dev/null || fail 'Nainstaluj GitHub CLI (brew install gh), pak gh auth login.'
gh auth status --hostname github.com >/dev/null 2>&1 || fail 'Nejprve spust gh auth login --hostname github.com --web.'
[[ -t 0 ]] || fail 'Spust skript v interaktivnim Terminalu.'
repo=ondraondra81/t3custom
environment=t3custom-apple
gh api "repos/$repo/environments/$environment" >/dev/null

printf 'Ulozim 5 secrets do GitHub environment t3custom-apple v %s.\n' "$repo"
read -r -p 'Cesta k exportovanemu certifikatu .p12 (bez uvozovek): ' certificate
[[ -f "$certificate" && "$certificate" == *.p12 ]] || fail 'Soubor .p12 nenalezen.'
[[ "$(wc -c < "$certificate")" -le 35000 ]] || fail 'Soubor je prilis velky pro GitHub Secret; exportuj pouze jednu podpisovou identitu.'
read -r -s -p 'Heslo exportu .p12: ' certificate_password
printf '\n'
read -r -p 'Apple Account e-mail: ' apple_id
read -r -p 'Apple Developer Team ID (10 znaku): ' team_id
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] || fail 'Team ID musi mit 10 velkych pismen/cislic.'
read -r -s -p 'App-specific password pro notarizaci (nikoli hlavni heslo Apple): ' apple_password
printf '\n'
[[ -n "$certificate_password" && -n "$apple_id" && -n "$apple_password" ]] || fail 'Nektery udaj je prazdny.'

base64 < "$certificate" | tr -d '\r\n' | gh secret set CSC_LINK --repo "$repo" --env "$environment"
printf '%s' "$certificate_password" | gh secret set CSC_KEY_PASSWORD --repo "$repo" --env "$environment"
printf '%s' "$apple_id" | gh secret set APPLE_ID --repo "$repo" --env "$environment"
printf '%s' "$apple_password" | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo "$repo" --env "$environment"
printf '%s' "$team_id" | gh secret set APPLE_TEAM_ID --repo "$repo" --env "$environment"
unset certificate_password apple_password
printf 'Hotovo. Udaje jsou v GitHub Secrets; zadny build se zatim nespustil.\n'

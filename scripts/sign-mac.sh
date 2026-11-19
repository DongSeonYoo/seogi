#!/bin/sh
# Signs Seogi.app with a fixed self-signed certificate, so macOS keeps recognising it as the same
# app across rebuilds and its privacy permissions (Screen & System Audio Recording) survive a
# reinstall. Ad-hoc signatures change with every build, which made macOS forget those grants.
#
# The certificate is made once, in a keychain of its own (not the login keychain, so signing never
# prompts). That keychain holds only this local, self-signed key; its password only unlocks it.
set -eu
APP="$1"
NAME="Seogi Local Signing"
KC="$HOME/Library/Keychains/seogi-signing.keychain-db"
PASS="${SEOGI_SIGNING_PASSWORD:-seogi-local}"

if [ ! -f "$KC" ]; then
  tmp=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=$NAME" \
    -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" 2>/dev/null
  # macOS imports only the older PKCS#12 algorithms.
  openssl pkcs12 -export -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/id.p12" -passout pass:"$PASS" \
    -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1
  security create-keychain -p "$PASS" "$KC"
  security set-keychain-settings "$KC" # never auto-locks
  security import "$tmp/id.p12" -k "$KC" -P "$PASS" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KC" >/dev/null
  rm -rf "$tmp"
  echo "Created the signing certificate \"$NAME\" in $KC"
fi

# codesign finds identities only in the search list; the login keychain stays first.
case "$(security list-keychains -d user)" in
  *seogi-signing.keychain-db*) ;;
  *) security list-keychains -d user -s $(security list-keychains -d user | tr -d '"') "$KC" ;;
esac
security unlock-keychain -p "$PASS" "$KC"
codesign --force --deep --sign "$NAME" "$APP"
codesign --verify --deep --strict "$APP"
echo "Signed $APP as \"$NAME\""

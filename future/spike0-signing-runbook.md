# Spike 0 — validate distribution signing on the build Mac (manual runbook)

Run this ONCE on `macbook-air-botflow` (`ssh botflow@100.119.219.31`) the moment the
Apple Developer enrollment + `.p8` key exist. It proves the only unverified link in
the publish chain: that a non-GUI session can create a distribution cert, sign an
archive, export an `.ipa`, and have Apple accept the upload. Everything else is
already typechecked code.

## Prereqs (gather first)
- Apple Developer Program membership ($99) active.
- ASC API key created at https://appstoreconnect.apple.com/access/integrations/api
  (role: **App Manager**) → you have: `AuthKey_<KEYID>.p8`, the **Key ID**, the
  **Issuer ID**, and your 10-char **Team ID** (Membership page).
- One app record created manually in ASC (My Apps → "+") whose bundle id you'll use
  below. Register the bundle id at developer.apple.com → Identifiers if needed.

## 1. One-time keychain setup (the part that breaks over SSH)
```bash
KC=botflow-signing.keychain
KCPW='pick-a-strong-password'     # record it — the host-agent env needs it later

security create-keychain -p "$KCPW" "$KC"
security list-keychains -d user -s "$KC" login.keychain-db
security set-keychain-settings "$KC"          # no -l/-t flags → never auto-locks
security unlock-keychain -p "$KCPW" "$KC"
security default-keychain -d user -s "$KC"    # new certs land in the default keychain
```
(Revert later if ever needed: `security default-keychain -d user -s login.keychain-db`.)

## 2. Stage the ASC key + a test project
```bash
mkdir -p ~/.appstoreconnect/private_keys
# scp the key over, then:
chmod 600 ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8

# Any Botflow-generated SwiftUI project works. Easiest source: run a simulator
# preview once from Botflow, then grab the unpacked workdir:
ls /tmp/sim-builds/            # pick the newest session dir, cp -R it to ~/spike
cd ~/spike && xcodegen generate
```

## 3. Archive (distribution-signed — THE critical test)
```bash
SCHEME=<SchemeName> TEAM=<TEAMID> KEYID=<KEYID> ISSUER=<ISSUERID> BUNDLE=<your.bundle.id>

xcodebuild archive \
  -project "$SCHEME.xcodeproj" -scheme "$SCHEME" \
  -sdk iphoneos -destination generic/platform=iOS \
  -archivePath "$PWD/$SCHEME.xcarchive" \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_$KEYID.p8 \
  -authenticationKeyID "$KEYID" -authenticationKeyIssuerID "$ISSUER" \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE" \
  MARKETING_VERSION=1.0.0 CURRENT_PROJECT_VERSION=1 \
  ENABLE_DEBUG_DYLIB=NO ENABLE_PREVIEWS=NO
```
Expected on first run: Xcode mints an "Apple Distribution" cert + profile via the API
key. **If it hangs or errors with an interaction/keychain message**, run the
prompt-free grant and retry — this is the classic gotcha:
```bash
security set-key-partition-list -S apple-tool:,apple: -s -k "$KCPW" "$KC"
```
Sanity check the cert exists: `security find-identity -v -p codesigning` → should
list `Apple Distribution: …`.

## 4. Export the signed .ipa
```bash
cat > ExportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>teamID</key><string>TEAMID_HERE</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
  <key>destination</key><string>export</string>
</dict>
</plist>
EOF
sed -i '' "s/TEAMID_HERE/$TEAM/" ExportOptions.plist

xcodebuild -exportArchive -archivePath "$PWD/$SCHEME.xcarchive" \
  -exportPath "$PWD/export" -exportOptionsPlist ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/.appstoreconnect/private_keys/AuthKey_$KEYID.p8 \
  -authenticationKeyID "$KEYID" -authenticationKeyIssuerID "$ISSUER"
ls export/*.ipa
```

## 5. Upload (manual check — production uses the REST BuildUpload API instead)
```bash
xcrun altool --upload-app -f export/*.ipa -t ios --apiKey "$KEYID" --apiIssuer "$ISSUER"
```
Success looks like "No errors uploading". Then watch the build appear under the app's
TestFlight tab in App Store Connect (processing takes a few minutes). Common
first-run rejections: missing 1024px app icon in the asset catalog; export
compliance unanswered (add `ITSAppUsesNonExemptEncryption=false` to the Info.plist /
project.yml); bundle id mismatch with the app record.

## 6. Wire the host-agent (after the spike passes)
Add to the host-agent's environment (wherever it's launched in ~/expo-stream):
```
SIGNING_KEYCHAIN=botflow-signing.keychain
SIGNING_KEYCHAIN_PASSWORD=<the $KCPW you chose>
```
The new `runAppStoreBuild()` unlocks it before each archive; the one-time
`set-key-partition-list` from step 3 keeps codesign prompt-free thereafter.

## Pass criteria
1. Archive completes over plain SSH with no GUI prompt. 2. `find-identity` shows the
distribution cert. 3. Export produces an `.ipa`. 4. Apple accepts the upload and the
build reaches TestFlight. When all four hold, the wired pipeline should work
end-to-end with zero code changes (REST upload replaces step 5).

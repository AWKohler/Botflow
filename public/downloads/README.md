# Companion downloads

`BotflowCompanion.zip` (macOS) is served here by Vercel's CDN and linked from
the "Run on iPhone → Companion offline" walkthrough.

It is produced by the companion repo's packaging script:

    botflow-companion/scripts/package-companion.sh

That script freezes the Python engine (PyInstaller), bundles it inside the
.app, signs, and copies the zip here. For a download that clears Gatekeeper on
other Macs, set DEVELOPER_ID + NOTARY_PROFILE before running it (notarization).

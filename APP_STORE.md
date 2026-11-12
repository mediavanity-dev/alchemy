# Publishing Alchemy to the App Store

The iOS app is the same web app, bundled inside a native shell with [Capacitor](https://capacitorjs.com).
Every file ships inside the app, so it works offline and isn't "just a website" (Apple rejects those).
Builds run on a GitHub-hosted Mac, so you never need a Mac yourself.

## What's in the repo

| Path | Purpose |
| --- | --- |
| `capacitor.config.json` | App ID `com.mediavanity.alchemy`, name, colours |
| `scripts/build-www.mjs` | Copies the web app into `www/` for the app. Strips Google Analytics and the service worker. |
| `js/native.js` | Uses the iOS share sheet for chord charts and MIDI files (only inside the app) |
| `ios/` | The Xcode project: microphone permission text, iPhone-only, portrait, audio session |
| `scripts/make-icons.mjs` | Renders the 1024px app icon and launch screen from `icons/icon.svg` |
| `.github/workflows/ios-testflight.yml` | Builds, signs and uploads to TestFlight |
| `privacy.html` | Privacy policy (served by GitHub Pages) |

After changing any web code, run `npm run ios:sync`. That rebuilds `www/` and copies it into the iOS project. Then commit and push.

## One-time setup

### 1. Join the Apple Developer Program ($99/year)
Go to https://developer.apple.com/programs/enroll/ and enroll as an **Individual** (quickest) or an Organization (needs a D-U-N-S number).
Approval usually takes from a few hours to two days.

### 2. Register the bundle ID
Go to developer.apple.com → Certificates, IDs & Profiles → Identifiers → **+** → App IDs → App.
Use the explicit bundle ID `com.mediavanity.alchemy`. No extra capabilities are needed.

### 3. Create the app record
In https://appstoreconnect.apple.com → Apps → **+** → New App:
- Platform: iOS. Name: **Alchemy**. If that name is taken, try "Alchemy: Hum to Harmony".
- Primary language: English (U.S.). Bundle ID: the one above. SKU: `alchemy-ios`.

### 4. Create an App Store Connect API key (this is how CI signs and uploads)
App Store Connect → Users and Access → **Integrations** → App Store Connect API → Team Keys → **+**.
- Access: **Admin**. CI needs it to create the signing certificate automatically.
- Download the `.p8` file. You can download it only once.
- Note the **Key ID** and the **Issuer ID** shown at the top of that page.
- Find your **Team ID** at developer.apple.com → Account → Membership details.

### 5. Add GitHub secrets
Go to github.com/mediavanity-dev/alchemy → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | Team ID |
| `ASC_KEY_ID` | Key ID |
| `ASC_ISSUER_ID` | Issuer ID |
| `ASC_KEY_P8` | Entire contents of the `.p8` file, including the BEGIN/END lines |

## Each release

1. Run `npm run ios:sync`, then commit and push.
2. In GitHub, go to **Actions → iOS → TestFlight → Run workflow**. It takes about 10–15 minutes.
3. In App Store Connect, open the app's **TestFlight** tab. The build appears after Apple finishes processing it (5–30 minutes).
   Add yourself as an internal tester, then install the **TestFlight** app on your iPhone.
4. Test on a real iPhone (see the checklist below).
5. For a new version, raise `MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj` (e.g. 1.0 → 1.1).
   The build number increases automatically with every workflow run.

## Things to test in TestFlight
- The microphone prompt appears once, and recording works (singing, quiet humming, an instrument).
- Playback is loud through the speaker, both with the **silent switch on** and while recording layers with a count-in.
- Bluetooth headphones: record and play back.
- Share → Chord chart and Share → MIDI file both open the iOS share sheet ("Save to Files" works).
- Import audio opens the file picker.
- Saved takes are still in the Library after force-quitting the app.
- Layout around the notch / Dynamic Island and the home indicator.

## Store listing (App Store Connect → the app → version 1.0)

- **Subtitle** (30 chars): `Hum a melody, find its chords`
- **Description** (draft):
  > Sing, hum or play a melody on any instrument, and Alchemy finds the key it sits in and the chords that fit underneath it.
  >
  > • Detects the key, including Dorian and Mixolydian modes
  > • Suggests chord progressions: triads, extended chords, or chromatic colour. Tap any chord to swap it.
  > • Choose how often the chord changes: every 2 bars, every bar, half bar or beat
  > • Lock the melody to the beat and gently correct the tuning
  > • Add layers of voices, instruments and beats, with a count-in and loop recording
  > • Export a MIDI file of melody, chords and bass for your DAW, or share a chord chart
  >
  > Everything happens on your iPhone. No account, no ads, no tracking.
- **Keywords** (100 chars): `chords,melody,harmony,songwriting,key finder,hum,sing,music theory,chord progression,midi,composer`
- **Category**: Music (secondary: Utilities)
- **Privacy Policy URL**: https://mediavanity-dev.github.io/alchemy/privacy.html
- **Support URL**: https://github.com/mediavanity-dev/alchemy (or any page with a way to contact you)
- **Age rating**: answer "None" to everything. The result is 4+.
- **App Privacy** questionnaire: **Data Not Collected**.
- **Pricing**: Free (or choose a price tier). Under Agreements, Tax and Banking, sign the Free Apps agreement.
- **Export compliance**: already answered in `Info.plist` (`ITSAppUsesNonExemptEncryption = NO`).
- **Screenshots**: required at **6.9"** (1320 × 2868 or 1290 × 2796). Capture them on your iPhone from the TestFlight build
  (side button + volume up). Suggested set: Capture screen while recording, Harmony view with chords, chord alternatives sheet, Tracks/layers, Library.
  3–5 screenshots are plenty.
- **App Review notes**: "Tap Record and sing or hum a short tune, then tap Stop. Or tap 'Try a demo' on the Capture screen to load a melody without using the microphone."

Then choose the build under the version → **Add for Review** → **Submit**. Review usually takes 1–3 days.

## Common rejection reasons
- **Guideline 4.2 (minimum functionality / web wrapper)**: covered, because the app is fully bundled, works offline, and uses the mic and native sharing.
  If it's raised anyway, reply with a description of the on-device audio analysis.
- **Guideline 5.1.1 (microphone purpose string)**: the text in `Info.plist` explains why the app needs the microphone.
- **Broken links or placeholder content**: make sure the privacy policy and support URLs load before you submit.

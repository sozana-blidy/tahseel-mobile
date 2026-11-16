# Build the Android APK (Windows, Command Prompt)

The APK is built on your machine (option A). EAS cloud build (option B) needs an expo.dev
account and may be blocked from Syria — use it only if A is not possible.

## A. Local build

### One-time setup
1. Install **Android Studio** (includes the Android SDK and a JDK). Open it once → More Actions →
   SDK Manager → make sure an Android SDK Platform and "Android SDK Build-Tools" are installed.
2. Environment variables (Command Prompt, then **open a new** Command Prompt):
   ```
   setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
   setx JAVA_HOME "C:\Program Files\Android\Android Studio\jbr"
   ```
3. Keep the project in a **short path without spaces** (e.g. `D:\dev\tahseel-mobile`). Even then some native
   object paths are ~340 chars, so also:
   - Android Studio → Settings → Android SDK → SDK Tools → tick **Show Package Details** → CMake → tick **4.0.2** → Apply.
     (`app.json` pins it via `plugins/withCmakeVersion.js`; the default 3.22.1 ships ninja 1.10 and fails with
     "Filename longer than 260 characters". If you install another version, change it in `app.json`.)
   - Windows long paths must be on (`LongPathsEnabled` = 1 — already set on this machine).
   - `sdkmanager` on the command line is blocked by Smart App Control here — install SDK parts from the Android Studio UI.
4. Create the release key **once** and back it up (USB + cloud). Losing it means every phone must
   uninstall and reinstall to get updates.
   ```
   mkdir C:\tahseel-keys
   "%JAVA_HOME%\bin\keytool" -genkeypair -v -storetype PKCS12 -keystore C:\tahseel-keys\tahseel-release.jks -alias tahseel -keyalg RSA -keysize 2048 -validity 10000
   ```
5. Tell Gradle where the key is — in `%USERPROFILE%\.gradle\gradle.properties` (outside the repo, never commit):
   ```
   TAHSEEL_UPLOAD_STORE_FILE=C:/tahseel-keys/tahseel-release.jks
   TAHSEEL_UPLOAD_STORE_PASSWORD=<store password>
   TAHSEEL_UPLOAD_KEY_ALIAS=tahseel
   TAHSEEL_UPLOAD_KEY_PASSWORD=<key password>
   ```
   (`plugins/withReleaseSigning.js` reads these; without them the APK is signed with the debug key — testing only.)

### Every build
1. `.env` must hold the real `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` — they are baked into the APK.
2. For an update: raise `version` (e.g. 1.0.1) **and** `android.versionCode` (+1) in `app.json`.
3. Build:
   ```
   pnpm install
   npx expo prebuild --platform android --clean
   cd android
   gradlew.bat assembleRelease
   cd ..
   ```
4. The APK: `android\app\build\outputs\apk\release\app-release.apk`. Copy it out (e.g. `copy ... D:\tahseel-apk\tahseel-1.0.0.apk`) —
   the next `prebuild --clean` deletes the whole `android` folder.
5. Check it is signed with the company key (not "CN=Android Debug"):
   ```
   "%ANDROID_HOME%\build-tools\37.0.0\apksigner.bat" verify --print-certs android\app\build\outputs\apk\release\app-release.apk
   ```

If `prebuild --clean` says **EBUSY … android**: a terminal is still sitting inside `android` (after `gradlew`) — `cd ..` or close it,
and run `cd android && gradlew.bat --stop` for leftover Gradle daemons.

### Install on phones
Send the APK by WhatsApp/Telegram or copy by USB → open it → allow "Install unknown apps" for that
app when Android asks → Install. Updates install over the old version (same key + higher versionCode).

## B. EAS cloud build (optional)
```
npm install -g eas-cli
eas login
eas init
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value https://<ref>.supabase.co --visibility plaintext
eas env:create --environment preview --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value <anon key> --visibility plaintext
eas build --platform android --profile apk
```
EAS keeps its own signing key; an APK from EAS cannot update one built locally (and vice versa) — pick one route.

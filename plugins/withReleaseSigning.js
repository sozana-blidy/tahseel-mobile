/**
 * Signs the Android release build with the company key.
 * The key and passwords never live in the repo: they are read at build time from
 * Gradle properties (put them in %USERPROFILE%\.gradle\gradle.properties):
 *   TAHSEEL_UPLOAD_STORE_FILE=C:\\keys\\tahseel-release.jks
 *   TAHSEEL_UPLOAD_STORE_PASSWORD=...
 *   TAHSEEL_UPLOAD_KEY_ALIAS=tahseel
 *   TAHSEEL_UPLOAD_KEY_PASSWORD=...
 * Without them the release build falls back to the debug key (fine for testing only).
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// tahseel-release-signing";

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    let src = cfg.modResults.contents;
    if (src.includes(MARK)) return cfg;
    const releaseConfig = `        release { ${MARK}
            if (project.hasProperty('TAHSEEL_UPLOAD_STORE_FILE')) {
                storeFile file(TAHSEEL_UPLOAD_STORE_FILE)
                storePassword TAHSEEL_UPLOAD_STORE_PASSWORD
                keyAlias TAHSEEL_UPLOAD_KEY_ALIAS
                keyPassword TAHSEEL_UPLOAD_KEY_PASSWORD
            }
        }`;
    // 1) add a release signing config next to the template's debug one
    src = src.replace(/(signingConfigs\s*\{[\s\S]*?debug\s*\{[\s\S]*?\}[ \t]*\n)/, `$1${releaseConfig}\n`);
    // 2) the release build type uses it when the key is configured
    src = src.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      `$1signingConfig project.hasProperty('TAHSEEL_UPLOAD_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
    );
    if (!src.includes(MARK) || !src.includes("signingConfigs.release")) {
      throw new Error("withReleaseSigning: android/app/build.gradle layout changed — update plugins/withReleaseSigning.js");
    }
    cfg.modResults.contents = src;
    return cfg;
  });
};

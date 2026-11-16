/**
 * Pins the CMake version used for every native (C++) build: the app and all libraries.
 *
 * Why: the SDK's default CMake 3.22.1 ships ninja 1.10, which fails on Windows with
 * "Filename longer than 260 characters" (react-native-safe-area-context, react-native-screens,
 * react-native-gesture-handler object paths are ~290–340 chars). CMake 3.28+ ships ninja 1.12+,
 * which honours Windows long paths (LongPathsEnabled=1).
 *
 * The version must be installed: Android Studio → Settings → Android SDK → SDK Tools →
 * "Show Package Details" → CMake → <version>.
 *
 * Usage in app.json: ["./plugins/withCmakeVersion", { "version": "3.31.6" }]
 */
const { withProjectBuildGradle } = require("expo/config-plugins");

const MARK = "// tahseel-cmake-version";

module.exports = function withCmakeVersion(config, props = {}) {
  const version = props.version;
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error('withCmakeVersion: pass { "version": "x.y.z" } (an installed SDK CMake version)');
  }
  return withProjectBuildGradle(config, (cfg) => {
    const src = cfg.modResults.contents;
    if (src.includes(MARK)) return cfg;
    const block = `${MARK}
subprojects { sub ->
  ["com.android.application", "com.android.library"].each { id ->
    sub.plugins.withId(id) {
      sub.android.externalNativeBuild.cmake.version = "${version}"
    }
  }
}

`;
    // Must come BEFORE the root plugins: "expo-root-project" evaluates :app as soon as it is
    // applied, after which AGP refuses the change ("It is too late to set version").
    const anchor = 'apply plugin: "expo-root-project"';
    if (!src.includes(anchor)) {
      throw new Error("withCmakeVersion: android/build.gradle layout changed — update plugins/withCmakeVersion.js");
    }
    cfg.modResults.contents = src.replace(anchor, block + anchor);
    return cfg;
  });
};

// App entry. Background tasks must be defined at bundle load, before any screen renders
// (a headless background run renders nothing), so they are imported before the router.
import "./src/lib/nightlyTask";
import "expo-router/entry";

import { Redirect } from "expo-router";
import { useAuth } from "../lib/auth";

/** Single entry point: sends each person to the one interface they are allowed to use. */
export default function Index() {
  const { session, profile } = useAuth();
  if (!session) return <Redirect href="/login" />;
  if (!profile) return <Redirect href="/inactive" />;
  return <Redirect href={profile.role === "manager" ? "/manager" : "/agent"} />;
}

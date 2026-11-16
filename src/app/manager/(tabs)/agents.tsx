import { router } from "expo-router";
import { useState } from "react";
import { Pressable, RefreshControl, ScrollView, Share, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useManager } from "../../../lib/managerContext";
import { inviteMessage, loadAgents, loadAreas, loadOpenInvites, type Invite } from "../../../lib/managerData";
import { formatK } from "../../../lib/money";
import { monthLabel } from "../../../lib/months";
import { rpc } from "../../../lib/rpc";
import { useLoad } from "../../../lib/useLoad";
import { Badge, Banner, Button, Card, Num, T } from "../../../ui/kit";
import { ltr, MonthBar, Stat } from "../../../ui/parts";
import { ConfirmSheet } from "../../../ui/sheets";
import { colors, space } from "../../../ui/theme";

export default function Agents() {
  const m = useManager();
  const { data, error, loading, refresh } = useLoad(async () => {
    const [agents, invites, areas] = await Promise.all([loadAgents(m.month), loadOpenInvites(), loadAreas()]);
    return { agents, invites, areas };
  }, [m.month]);
  const [revoke, setRevoke] = useState<Invite | null>(null);

  const agents = data?.agents ?? [];
  const totalHolding = agents.reduce((a, x) => a + x.totals.holding, 0);
  const freeAreas = (data?.areas ?? []).filter((a) => !a.agent_id);
  const areaName = (id: string) => data?.areas.find((a) => a.id === id)?.name ?? "؟";

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <ScrollView
        contentContainerStyle={{ padding: space(4), gap: space(3), paddingBottom: space(10) }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <T w="bold" size={22} style={{ flex: 1 }}>المعتمدون</T>
          <Button title="+ دعوة معتمد" variant="secondary" onPress={() => router.push("/manager/invite")} style={{ minHeight: 40 }} />
        </View>
        <Button title="إنشاء حسابات (اسم دخول + كلمة مرور)" onPress={() => router.push("/manager/accounts")} />
        <MonthBar months={m.months} month={m.month} onPick={m.setMonth} />
        {error && <Banner tone="error" text={error} />}

        <Card style={{ gap: space(1) }}>
          <T color={colors.muted}>أموال عند المعتمدين — {monthLabel(m.month)}</T>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: space(2) }}>
            <Num w="bold" size={28} color={colors.primary}>{formatK(totalHolding)}</Num>
            <T color={colors.muted}>ألف ل.س</T>
          </View>
        </Card>

        {agents.map((a) => (
          <Pressable key={a.profile.id} onPress={() => router.push({ pathname: "/manager/agent/[id]", params: { id: a.profile.id } })} accessibilityRole="button">
            <Card style={{ gap: space(2.5), opacity: a.profile.active ? 1 : 0.6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: space(2) }}>
                <View style={{ flex: 1 }}>
                  <T w="bold" size={18}>{a.profile.full_name}</T>
                  <T size={14} color={colors.muted}>{a.areas.map((x) => x.name).join("، ") || "بدون مناطق"}</T>
                </View>
                {!a.profile.active && <Badge label="موقوف" fg={colors.danger} bg={colors.dangerSoft} />}
              </View>
              <View style={{ flexDirection: "row", gap: space(2) }}>
                <Stat label="حصّل" count={a.totals.count} amount={a.totals.collected} color={colors.paid} />
                <Stat label="سلّم" amount={a.totals.delivered + a.totals.deductions} />
                <Stat label="معه" amount={a.totals.holding} color={colors.primary} />
              </View>
            </Card>
          </Pressable>
        ))}

        {freeAreas.length > 0 && (
          <Card style={{ gap: space(1) }}>
            <T w="bold">مناطق يجمعها المدير</T>
            <T color={colors.muted}>{freeAreas.map((a) => a.name).join("، ")}</T>
          </Card>
        )}

        {(data?.invites.length ?? 0) > 0 && (
          <Card style={{ gap: space(3) }}>
            <T w="bold">دعوات لم تُستخدم بعد</T>
            {data!.invites.map((i) => (
              <View key={i.code} style={{ gap: space(1.5) }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                  <T w="medium">{i.full_name}</T>
                  <Num w="bold" size={18} style={{ letterSpacing: 2 }}>{i.code}</Num>
                </View>
                <T size={13} color={colors.muted}>{i.area_ids.map(areaName).join("، ")} · ينتهي {ltr(i.expires_at.slice(0, 10))}</T>
                <View style={{ flexDirection: "row", gap: space(2) }}>
                  <Button title="مشاركة" variant="secondary" onPress={() => Share.share({ message: inviteMessage(i) })} style={{ flex: 1, minHeight: 40 }} />
                  <Button title="إلغاء الدعوة" variant="ghost" onPress={() => setRevoke(i)} style={{ flex: 1, minHeight: 40 }} />
                </View>
              </View>
            ))}
          </Card>
        )}
      </ScrollView>
      {revoke && (
        <ConfirmSheet
          title="إلغاء الدعوة"
          body={`لن يعمل الرمز ${revoke.code} بعد الآن، وتعود مناطقه متاحة.`}
          action="إلغاء الدعوة"
          onClose={() => setRevoke(null)}
          run={() => rpc("revoke_agent_invite", { p_code: revoke.code })}
        />
      )}
    </SafeAreaView>
  );
}

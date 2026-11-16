import { useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { loadGuestArea, searchGuestRows } from "../../lib/guest";
import { monthLabel } from "../../lib/months";
import { useLoad } from "../../lib/useLoad";
import { Badge, Banner, Card, T, s as kit } from "../../ui/kit";
import { Empty, Header } from "../../ui/parts";
import { STATUS } from "../../ui/status";
import { colors, font, space } from "../../ui/theme";

/** Guest: one area — names and paid / unpaid / exempt, with search. No actions of any kind. */
export default function GuestArea() {
  const { id, name, month } = useLocalSearchParams<{ id: string; name: string; month: string }>();
  const { data, error, loading, refresh } = useLoad(() => loadGuestArea(month, id), [month, id]);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => searchGuestRows(data ?? [], query), [data, query]);
  const paid = (data ?? []).filter((r) => r.status === "paid").length;

  return (
    <SafeAreaView style={{ flex: 1 }} edges={["top", "left", "right"]}>
      <Header title={name ?? "المنطقة"} subtitle={month ? `${monthLabel(month)} · دفع ${paid} من ${data?.length ?? "…"}` : undefined} />
      <FlatList
        data={rows}
        keyExtractor={(r, i) => `${i}:${r.display_name}`}
        contentContainerStyle={{ padding: space(4), paddingTop: 0, gap: space(2), paddingBottom: space(10) }}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[colors.primary]} />}
        ListHeaderComponent={
          <View style={{ gap: space(2), marginBottom: space(1) }}>
            {error ? <Banner tone="error" text={error} /> : null}
            <View style={[kit.input, { flexDirection: "row", alignItems: "center", paddingHorizontal: space(3) }]}>
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="ابحث بالاسم"
                placeholderTextColor={colors.muted}
                style={{ flex: 1, fontFamily: font.regular, fontSize: 17, color: colors.text, paddingVertical: space(2) }}
                autoCorrect={false}
                returnKeyType="search"
                contextMenuHidden
                accessibilityLabel="بحث"
              />
              {query ? (
                <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="مسح البحث">
                  <T size={20} color={colors.muted}>✕</T>
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const st = STATUS[item.status];
          return (
            <Card style={{ padding: space(3.5), flexDirection: "row", alignItems: "center", gap: space(3) }}>
              <T w="medium" size={16} style={{ flex: 1 }}>{item.display_name}</T>
              <Badge label={st.label} fg={st.fg} bg={st.bg} />
            </Card>
          );
        }}
        ListEmptyComponent={data ? <Empty text={query ? "لا نتائج" : "لا يوجد مشتركون"} /> : undefined}
      />
    </SafeAreaView>
  );
}

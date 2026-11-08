import type { PropsWithChildren } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
export function Form({ children }: PropsWithChildren) {
  return <View style={styles.form}>{children}</View>;
}
export function FormActions({ children }: PropsWithChildren) {
  return <View style={styles.actions}>{children}</View>;
}
const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[4] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
}));

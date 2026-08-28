import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { ICON_SIZE } from "@/styles/theme";

interface CopyButtonProps {
  getContent: () => string;
  onCopy: (content: string) => Promise<void>;
  containerStyle?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  copiedAccessibilityLabel?: string;
  testID?: string;
}

const COPIED_RESET_MS = 1500;

export const CopyButton = React.memo(function CopyButton({
  getContent,
  onCopy,
  containerStyle,
  accessibilityLabel,
  copiedAccessibilityLabel,
  testID,
}: CopyButtonProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopy = useCallback(async () => {
    const content = getContent();
    if (!content) {
      return;
    }

    await onCopy(content);
    setCopied(true);

    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }

    copyTimeoutRef.current = setTimeout(() => {
      setCopied(false);
      copyTimeoutRef.current = null;
    }, COPIED_RESET_MS);
  }, [getContent, onCopy]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const pressableStyle = useMemo(() => [styles.container, containerStyle], [containerStyle]);

  return (
    <Pressable
      testID={testID}
      onPress={handleCopy}
      style={pressableStyle}
      accessibilityRole="button"
      accessibilityLabel={
        copied
          ? (copiedAccessibilityLabel ?? t("message.actions.copied"))
          : (accessibilityLabel ?? t("message.actions.copyTurn"))
      }
    >
      {({ hovered }) => {
        const iconColor = hovered ? styles.iconHoveredColor.color : styles.iconColor.color;
        return copied ? (
          <Check size={ICON_SIZE.sm} color={iconColor} />
        ) : (
          <Copy size={ICON_SIZE.sm} color={iconColor} />
        );
      }}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    padding: theme.spacing[1],
  },
  iconColor: {
    color: theme.colors.foregroundMuted,
  },
  iconHoveredColor: {
    color: theme.colors.foreground,
  },
}));

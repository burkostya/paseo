import { RefreshControl, View, type LayoutChangeEvent } from "react-native";
import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import DraggableFlatList, {
  NestableDraggableFlatList,
  type RenderItemParams,
} from "react-native-draggable-flatlist";
import type { useAnimatedValues } from "react-native-draggable-flatlist/lib/typescript/context/animatedValueContext";
import { useUnistyles } from "react-native-unistyles";
import type {
  DraggableDropIntent,
  DraggableListProps,
  DraggableRenderItemInfo,
} from "./draggable-list.types";
import {
  WORKSPACE_TREE_ROOT_DROP_ZONE_ID,
  resolveWorkspaceTreeDropFromMeasurements,
  type WorkspaceTreeDropMeasurement,
} from "./sidebar/workspace-tree-dnd";

/* oxlint-disable react-perf/jsx-no-new-function-as-prop -- cell measurement callbacks need keys. */

export type { DraggableListProps, DraggableRenderItemInfo };

const SCROLL_ENABLED_FLEX_STYLE = { flex: 1 };
type NativeAnimatedValues = ReturnType<typeof useAnimatedValues>;

interface MeasurableView {
  measureLayout?: (
    relativeToNativeNode: unknown,
    onSuccess: (left: number, top: number, width: number, height: number) => void,
    onFail?: () => void,
  ) => void;
}

export function DraggableList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  onDragEndWithIntent,
  style,
  containerStyle,
  contentContainerStyle,
  testID,
  ListFooterComponent,
  ListHeaderComponent,
  ListEmptyComponent,
  treeRootDropZone,
  showsVerticalScrollIndicator = true,
  scrollEnabled = true,
  useDragHandle: _useDragHandle = false,
  refreshing,
  onRefresh,
  extraData,
  simultaneousGestureRef,
  gestureHostPresented,
  waitFor,
  onDragBegin: onDragBeginProp,
  nestable = false,
}: DraggableListProps<T>) {
  const { theme } = useUnistyles();
  const [isDragging, setIsDragging] = useState(false);
  const listContainerRef = useRef<unknown>(null);
  const animationValuesRef = useRef<NativeAnimatedValues | null>(null);
  const nativeIntentRef = useRef<{
    sourceKey: string;
    intent: DraggableDropIntent | null;
  } | null>(null);
  const rowMeasurementsRef = useRef<Map<string, WorkspaceTreeDropMeasurement>>(new Map());
  const rowHeightsRef = useRef<Map<string, number>>(new Map());
  const rowNodesRef = useRef<Map<string, MeasurableView | null>>(new Map());
  const rootDropZoneNodeRef = useRef<MeasurableView | null>(null);
  const rootDropZoneMeasurementRef = useRef<WorkspaceTreeDropMeasurement | null>(null);
  const latestDataRef = useRef(data);
  latestDataRef.current = data;

  // Pass the ref directly to DraggableFlatList - it handles gesture
  // coordination internally for nestable lists.
  const simultaneousHandlers = useMemo(
    () => (simultaneousGestureRef ? [simultaneousGestureRef] : undefined),
    [simultaneousGestureRef],
  );

  const refreshColors = useMemo(
    () => [theme.colors.foregroundMuted],
    [theme.colors.foregroundMuted],
  );

  const handleRowLayout = useCallback((itemKey: string, event: LayoutChangeEvent) => {
    const size = event.nativeEvent.layout.height;
    rowHeightsRef.current.set(itemKey, size);
    const node = rowNodesRef.current.get(itemKey);
    const container = listContainerRef.current;
    const save = (offset: number, measuredSize: number = size) => {
      rowMeasurementsRef.current.set(itemKey, {
        workspaceKey: itemKey,
        offset,
        size: measuredSize > 0 ? measuredSize : size,
      });
    };
    if (node && container && node.measureLayout) {
      node.measureLayout(
        container,
        (_left, top, _width, measuredHeight) => save(top, measuredHeight),
        () => save(rowMeasurementsRef.current.get(itemKey)?.offset ?? 0),
      );
      return;
    }
    save(rowMeasurementsRef.current.get(itemKey)?.offset ?? 0);
  }, []);

  const handleRenderItem = useCallback(
    ({ item, drag, isActive, getIndex }: RenderItemParams<T>) => {
      const index = getIndex() ?? 0;
      const itemKey = keyExtractor(item, index);
      const info: DraggableRenderItemInfo<T> = {
        item,
        index,
        drag,
        isActive,
      };
      const rendered = renderItem(info);
      if (!onDragEndWithIntent) return rendered;
      return (
        <View
          ref={(node: View | null) => {
            const measurable = node as MeasurableView | null;
            rowNodesRef.current.set(itemKey, measurable);
            if (measurable) {
              rowMeasurementsRef.current.set(itemKey, {
                workspaceKey: itemKey,
                offset: rowMeasurementsRef.current.get(itemKey)?.offset ?? 0,
                size: rowHeightsRef.current.get(itemKey) ?? 0,
              });
            }
          }}
          onLayout={(event) => handleRowLayout(itemKey, event)}
        >
          {rendered}
        </View>
      );
    },
    [handleRowLayout, keyExtractor, onDragEndWithIntent, renderItem],
  );

  const handleContainerLayout = useCallback(
    ({ containerRef }: { containerRef: { current: unknown } }) => {
      listContainerRef.current = containerRef.current;
    },
    [],
  );

  const handleRootDropZoneLayout = useCallback((event: LayoutChangeEvent) => {
    const size = event.nativeEvent.layout.height;
    const node = rootDropZoneNodeRef.current;
    const container = listContainerRef.current;
    const save = (offset: number, measuredSize: number = size) => {
      rootDropZoneMeasurementRef.current = {
        workspaceKey: WORKSPACE_TREE_ROOT_DROP_ZONE_ID,
        offset,
        size: measuredSize > 0 ? measuredSize : size,
      };
    };
    if (node && container && node.measureLayout) {
      node.measureLayout(
        container,
        (_left, top, _width, measuredHeight) => save(top, measuredHeight),
        () => save(rootDropZoneMeasurementRef.current?.offset ?? 0),
      );
      return;
    }
    save(rootDropZoneMeasurementRef.current?.offset ?? 0);
  }, []);

  const resolveNativeIntent = useCallback(
    (sourceIndex: number): { sourceKey: string; intent: DraggableDropIntent | null } | null => {
      const source = latestDataRef.current[sourceIndex];
      if (!source) return null;
      const sourceKey = keyExtractor(source, sourceIndex);
      const animationValues = animationValuesRef.current;
      if (!animationValues) return { sourceKey, intent: null };

      let fallbackOffset = 0;
      const measurements = latestDataRef.current.map((item, index) => {
        const key = keyExtractor(item, index);
        const measured = rowMeasurementsRef.current.get(key);
        const size = measured?.size ?? rowHeightsRef.current.get(key) ?? 0;
        // NestableDraggableFlatList measures the list container for its own auto-scroll
        // bookkeeping and deliberately does not expose that callback to this wrapper. Row
        // measurements therefore have no reliable list-relative offset in that mode. The flat
        // tree is rendered in order, so the measured heights provide the same local coordinates
        // without depending on a container ref that belongs to the outer scroll view.
        const offset = nestable ? fallbackOffset : (measured?.offset ?? fallbackOffset);
        fallbackOffset = offset + size;
        return {
          workspaceKey: key,
          offset,
          size,
        };
      });
      const resolvedIntent = resolveWorkspaceTreeDropFromMeasurements({
        activeOffset: animationValues.hoverOffset.value,
        activeSize: animationValues.activeCellSize.value,
        sourceWorkspaceKey: sourceKey,
        measurements,
        rootDropZone: (() => {
          const measured = rootDropZoneMeasurementRef.current;
          if (!treeRootDropZone || !measured || measured.size <= 0) return measured;
          return nestable ? { ...measured, offset: fallbackOffset } : measured;
        })(),
      });
      let intent: DraggableDropIntent | null = null;
      if (resolvedIntent) {
        intent =
          resolvedIntent.kind === "root"
            ? { kind: "root" }
            : { kind: resolvedIntent.kind, targetKey: resolvedIntent.targetWorkspaceKey };
      }
      return { sourceKey, intent };
    },
    [keyExtractor, nestable, treeRootDropZone],
  );

  const handleAnimValInit = useCallback((values: NativeAnimatedValues) => {
    animationValuesRef.current = values;
  }, []);

  const handleDragEnd = useCallback(
    ({ data: newData, from, to }: { data: T[]; from: number; to: number }) => {
      setIsDragging(false);
      if (!onDragEndWithIntent) {
        onDragEnd(newData);
        return;
      }
      const releasedIntent = nativeIntentRef.current;
      nativeIntentRef.current = null;
      const resolved = releasedIntent ?? resolveNativeIntent(from);
      // A tree drop can change the parent while the row keeps the same flat index (for example,
      // dropping the row into the centre of a nearby target). Ordinary lists retain their old
      // no-op behavior for an unchanged index.
      if (from === to && !resolved?.intent) return;
      const source = latestDataRef.current[from] ?? data[from];
      if (!source) return;
      if (resolved?.intent) {
        onDragEndWithIntent(newData, resolved.intent, resolved.sourceKey);
        return;
      }
      // `to` is the source's final index. Pick the row it crossed at the edge of the
      // destination, rather than the source itself, so the tree resolver can place it before or
      // after that row.
      const targetIndex = from < to ? to - 1 : to + 1;
      const target = newData[targetIndex];
      if (!target) {
        onDragEndWithIntent(newData, { kind: "root" }, keyExtractor(source, from));
        return;
      }
      onDragEndWithIntent(
        newData,
        {
          kind: from < to ? "after" : "before",
          targetKey: keyExtractor(target, targetIndex),
        },
        keyExtractor(source, from),
      );
    },
    [data, keyExtractor, onDragEnd, onDragEndWithIntent, resolveNativeIntent],
  );

  const handleDragBegin = useCallback(() => {
    setIsDragging(true);
    onDragBeginProp?.();
  }, [onDragBeginProp]);

  const handleRelease = useCallback(() => {
    setIsDragging(false);
  }, []);

  const showRefreshControl = Boolean(onRefresh) && (!isDragging || Boolean(refreshing));
  const resolvedContainerStyle =
    containerStyle ?? (scrollEnabled ? SCROLL_ENABLED_FLEX_STYLE : undefined);
  const shouldShowRefreshControl = showRefreshControl && !nestable;
  const ListComponent: typeof DraggableFlatList = (
    nestable ? (NestableDraggableFlatList as unknown) : DraggableFlatList
  ) as typeof DraggableFlatList;
  // NestableDraggableFlatList installs its own container-layout callback to measure the
  // list's offset inside the shared scroll container. Passing a prop here would override
  // that callback in the dependency's prop spread, so only regular lists receive ours.
  const containerLayoutProps = nestable ? undefined : { onContainerLayout: handleContainerLayout };

  const refreshControl = useMemo(
    () =>
      shouldShowRefreshControl ? (
        <RefreshControl
          refreshing={refreshing ?? false}
          onRefresh={onRefresh}
          tintColor={theme.colors.foregroundMuted}
          colors={refreshColors}
        />
      ) : undefined,
    [shouldShowRefreshControl, refreshing, onRefresh, theme.colors.foregroundMuted, refreshColors],
  );

  const resolvedListFooter = useMemo<ReactElement | null>(() => {
    if (!onDragEndWithIntent || !treeRootDropZone) return ListFooterComponent ?? null;
    return (
      <View>
        <View
          ref={(node: View | null) => {
            rootDropZoneNodeRef.current = node as MeasurableView | null;
          }}
          onLayout={handleRootDropZoneLayout}
        >
          {treeRootDropZone}
        </View>
        {ListFooterComponent}
      </View>
    );
  }, [ListFooterComponent, handleRootDropZoneLayout, onDragEndWithIntent, treeRootDropZone]);

  // The item wrapper needs per-cell measurement callbacks; these callbacks are intentionally
  // recreated with the cell key because React Native invokes them for the mounted cell.
  // oxlint-disable-next-line react-perf/jsx-no-new-function-as-prop
  return (
    <ListComponent
      testID={testID}
      data={data}
      keyExtractor={keyExtractor}
      renderItem={handleRenderItem}
      onDragEnd={handleDragEnd}
      style={style}
      containerStyle={resolvedContainerStyle}
      contentContainerStyle={contentContainerStyle}
      ListFooterComponent={resolvedListFooter}
      ListHeaderComponent={ListHeaderComponent}
      ListEmptyComponent={ListEmptyComponent}
      showsVerticalScrollIndicator={showsVerticalScrollIndicator}
      scrollEnabled={scrollEnabled}
      extraData={extraData}
      simultaneousHandlers={simultaneousHandlers}
      dragGestureHostPresented={gestureHostPresented}
      // Higher activation distance reduces accidental drag capture while nested
      // lists are inside a scroll container.
      activationDistance={20}
      onDragBegin={handleDragBegin}
      // oxlint-disable-next-line react-perf/jsx-no-new-function-as-prop
      onRelease={(index) => {
        if (onDragEndWithIntent) {
          // `onRelease` runs on the UI-thread release boundary before the library springs the
          // placeholder home. The shared values still describe the user's actual drop point.
          // The intent is read once here and consumed by `onDragEnd`, never on every frame.
          const resolved = resolveNativeIntent(index);
          nativeIntentRef.current = resolved;
        }
        handleRelease();
      }}
      onAnimValInit={handleAnimValInit}
      {...containerLayoutProps}
      // @ts-ignore - waitFor is supported by RNGH FlatList but missing from DraggableFlatList types
      waitFor={waitFor}
      refreshControl={refreshControl}
    />
  );
}

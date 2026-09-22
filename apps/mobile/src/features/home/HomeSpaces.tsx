import {
  assignProjectKeysToSpace,
  derivePhysicalProjectKey,
} from "@t3tools/client-runtime/state/project-grouping";
import type { ProjectSpace } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { uuidv4 } from "../../lib/uuid";
import type { HomeProjectScope } from "./homeThreadList";

export function HomeSpaces(props: {
  spaces: ReadonlyArray<ProjectSpace>;
  scopes: ReadonlyArray<HomeProjectScope>;
  activeSpaceId: string | null;
  onSelect: (spaceId: string | null) => void;
  onChange: (spaces: ReadonlyArray<ProjectSpace>) => void;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const editingSpace =
    editingId === "new" ? null : (props.spaces.find((space) => space.id === editingId) ?? null);
  const [name, setName] = useState("");
  const openEditor = (space: ProjectSpace | null) => {
    setEditingId(space?.id ?? "new");
    setName(space?.name ?? "");
  };
  const closeEditor = () => setEditingId(null);
  const saveName = () => {
    const nextName = name.trim();
    if (!nextName) return;
    if (editingId === "new") {
      const id = uuidv4();
      props.onChange([...props.spaces, { id, name: nextName, projectKeys: [] }]);
      props.onSelect(id);
    } else if (editingSpace) {
      props.onChange(
        props.spaces.map((space) =>
          space.id === editingSpace.id ? { ...space, name: nextName } : space,
        ),
      );
    }
    closeEditor();
  };
  const assignedScopeKeys = useMemo(() => new Set(editingSpace?.projectKeys ?? []), [editingSpace]);

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="items-center gap-2 px-4 py-2"
        accessibilityRole="tablist"
      >
        <SpaceChip
          label="All"
          selected={props.activeSpaceId === null}
          onPress={() => props.onSelect(null)}
        />
        {props.spaces.map((space) => (
          <SpaceChip
            key={space.id}
            label={space.name}
            selected={props.activeSpaceId === space.id}
            onPress={() => props.onSelect(space.id)}
            onLongPress={() => openEditor(space)}
          />
        ))}
        <SpaceChip label="+ Space" selected={false} onPress={() => openEditor(null)} />
      </ScrollView>

      <Modal
        visible={editingId !== null}
        transparent
        animationType="fade"
        onRequestClose={closeEditor}
      >
        <Pressable
          className="flex-1 items-center justify-center bg-black/40 px-6"
          onPress={closeEditor}
        >
          <Pressable
            className="w-full max-w-md gap-4 rounded-3xl bg-background p-5"
            onPress={(event) => event.stopPropagation()}
          >
            <Text className="text-lg font-semibold">
              {editingSpace ? "Edit Space" : "New Space"}
            </Text>
            <AppTextInput
              autoFocus
              value={name}
              onChangeText={setName}
              placeholder="Space name"
              className="min-h-0 rounded-xl py-2.5"
              onSubmitEditing={saveName}
            />

            {editingSpace ? (
              <View className="max-h-72 gap-1">
                <Text className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                  Projects
                </Text>
                <ScrollView>
                  {props.scopes.map((scope) => {
                    const keys = scope.projects.map(derivePhysicalProjectKey);
                    const assigned = keys.some((key) => assignedScopeKeys.has(key));
                    return (
                      <Pressable
                        key={scope.key}
                        className="flex-row items-center justify-between rounded-xl px-3 py-2.5 active:bg-muted"
                        onPress={() =>
                          props.onChange(
                            assignProjectKeysToSpace(
                              props.spaces,
                              assigned ? null : editingSpace.id,
                              keys,
                            ),
                          )
                        }
                      >
                        <Text className="flex-1" numberOfLines={1}>
                          {scope.title}
                        </Text>
                        <Text className="text-muted-foreground">{assigned ? "✓" : ""}</Text>
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </View>
            ) : null}

            <View className="flex-row justify-end gap-2">
              {editingSpace ? (
                <Pressable
                  className="mr-auto rounded-xl px-3 py-2"
                  onPress={() =>
                    Alert.alert("Delete Space?", "Projects will return to All Spaces.", [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Delete",
                        style: "destructive",
                        onPress: () => {
                          props.onChange(
                            props.spaces.filter((space) => space.id !== editingSpace.id),
                          );
                          if (props.activeSpaceId === editingSpace.id) props.onSelect(null);
                          closeEditor();
                        },
                      },
                    ])
                  }
                >
                  <Text className="text-destructive">Delete</Text>
                </Pressable>
              ) : null}
              <Pressable className="rounded-xl px-3 py-2" onPress={closeEditor}>
                <Text>Cancel</Text>
              </Pressable>
              <Pressable className="rounded-xl bg-primary px-4 py-2" onPress={saveName}>
                <Text className="font-medium text-primary-foreground">Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

function SpaceChip(props: {
  label: string;
  selected: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: props.selected }}
      className={`rounded-full px-3 py-1.5 ${props.selected ? "bg-primary" : "bg-muted"}`}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
    >
      <Text
        className={`text-sm font-medium ${props.selected ? "text-primary-foreground" : "text-foreground"}`}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

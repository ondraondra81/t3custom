import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { projectGroupPaths } from "@t3tools/client-runtime/t3custom/projectGroups";
import type { ProjectGroup } from "@t3tools/contracts/t3custom/projectGroups";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { FlatList, Modal, Pressable, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppText } from "../components/ui/AppText";
import { Button } from "../components/ui/Button";
import { IconButton } from "../components/ui/IconButton";
import { Menu } from "../components/ui/Menu";
import * as Dialog from "../components/ui/Dialog";
import { useNavigationThreadShells, useProjects, useServerConfigs } from "../state/entities";
import { useWorkspaceEnvironments } from "../state/workspace";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../state/use-composer-drafts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useSelectWorkspaceDetail } from "../features/layout/workspace/useSelectWorkspaceDetail";
import {
  coordinationPrompt,
  groupDescendants,
  mobileGroupRows,
  type GroupTreeRow,
} from "./projectGroupsTree";
import { useProjectGroups } from "./useProjectGroups";

export function ProjectGroupsButton() {
  const configs = useServerConfigs();
  const environments = useWorkspaceEnvironments().filter(
    (environment) =>
      configs.get(environment.environmentId)?.environment.capabilities.t3customProjectGroups ===
      true,
  );
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environment =
    environments.find((entry) => entry.environmentId === selected) ?? environments[0];
  const selectDetail = useSelectWorkspaceDetail();
  if (!environment) return null;
  const openThread = (environmentId: EnvironmentId, threadId: ThreadId) => {
    setOpen(false);
    selectDetail({ name: "Thread", params: { environmentId, threadId } });
  };
  return (
    <>
      <Button label="Project groups" tone="text" size="compact" onPress={() => setOpen(true)} />
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <SafeAreaView className="flex-1 bg-screen" edges={["top", "bottom"]}>
          <View className="flex-row items-center justify-between px-4 py-2">
            <AppText className="text-xl font-t3-medium text-foreground">Project groups</AppText>
            <Button label="Done" tone="text" onPress={() => setOpen(false)} />
          </View>
          <View className="px-4 pb-2">
            <Menu
              actions={environments.map((entry) => ({
                id: entry.environmentId,
                title: entry.environmentLabel,
              }))}
              onPressAction={({ nativeEvent }) => {
                const entry = environments.find((item) => item.environmentId === nativeEvent.event);
                if (entry) setSelected(entry.environmentId);
              }}
            >
              <Button
                label={environment.environmentLabel}
                tone="secondary"
                size="compact"
                onPress={() => {}}
              />
            </Menu>
          </View>
          {open ? (
            <ProjectGroupsTree
              key={environment.environmentId}
              environmentId={environment.environmentId}
              onOpenThread={openThread}
            />
          ) : null}
        </SafeAreaView>
      </Modal>
    </>
  );
}

function ProjectGroupsTree(props: {
  environmentId: EnvironmentId;
  onOpenThread: (environmentId: EnvironmentId, threadId: ThreadId) => void;
}) {
  const controller = useProjectGroups(props.environmentId);
  const projects = useProjects();
  const threads = useNavigationThreadShells();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set());
  const { snapshot, writable, pending } = controller;
  const disabled = !writable || pending;
  const toggle = (current: ReadonlySet<string>, id: string) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const nameGroup = (parentId: string | null, group?: ProjectGroup) => {
    Dialog.prompt({
      title: group ? "Rename group" : "New group",
      initialValue: group?.name ?? "",
      confirmText: group ? "Rename" : "Create",
      onConfirm: (value) => {
        const name = value.trim();
        if (!name || name.length > 120) {
          Dialog.alert("Group name", "Enter between 1 and 120 characters.");
          return;
        }
        void controller.mutate(
          group
            ? { type: "rename", groupId: group.id, name }
            : { type: "create", group: { id: randomUUID(), name, parentId } },
        );
      },
    });
  };
  const coordinate = async (group: ProjectGroup, resumeThreadId?: ThreadId) => {
    const threadId = await controller.coordinate(group.id, resumeThreadId);
    if (!threadId || !snapshot) return;
    await waitForComposerDraftsLoaded();
    const key = scopedThreadKey(props.environmentId, threadId);
    const draft = getComposerDraftSnapshot(key);
    if (!draft.text && draft.attachments.length === 0 && !draft.context) {
      setComposerDraftText(key, coordinationPrompt(props.environmentId, group, snapshot, projects));
    }
    props.onOpenThread(props.environmentId, threadId);
  };
  const paths = snapshot ? projectGroupPaths(snapshot) : new Map<string, string>();
  const destinationActions = (exclude: ReadonlySet<string>) => [
    { id: "move:root", title: "Top level", attributes: { disabled } },
    ...[...paths]
      .filter(([id]) => !exclude.has(id))
      .map(([id, title]) => ({ id: `move:group:${id}`, title, attributes: { disabled } })),
  ];
  const rows = snapshot
    ? mobileGroupRows({
        environmentId: props.environmentId,
        snapshot,
        projects,
        threads,
        collapsed,
        expandedProjects,
      })
    : [];
  const renderRow = ({ item }: { item: GroupTreeRow }) => {
    const label =
      item.kind === "group"
        ? item.group.name
        : item.kind === "project"
          ? item.project.title
          : item.kind === "pending"
            ? "Retry coordination setup"
            : item.thread.title;
    const onPress = () => {
      switch (item.kind) {
        case "group":
          setCollapsed((value) => toggle(value, item.group.id));
          break;
        case "project":
          setExpandedProjects((value) => toggle(value, item.project.id));
          break;
        case "thread":
          props.onOpenThread(props.environmentId, item.thread.id);
          break;
        case "pending": {
          const group = snapshot?.groups.find((entry) => entry.id === item.entry.groupId);
          if (group) void coordinate(group, item.entry.threadId);
        }
      }
    };
    const actions =
      item.kind === "group"
        ? [
            {
              id: "coordinate",
              title: "New coordination thread",
              attributes: { disabled: !controller.canCoordinate || pending },
            },
            { id: "create", title: "New subgroup", attributes: { disabled } },
            { id: "rename", title: "Rename", attributes: { disabled } },
            {
              id: "move",
              title: "Move to",
              subactions: destinationActions(
                snapshot ? groupDescendants(snapshot, item.group.id) : new Set(),
              ),
            },
            { id: "remove", title: "Remove group", attributes: { disabled, destructive: true } },
          ]
        : item.kind === "project" && !item.project.isScratch
          ? [{ id: "move", title: "Move to", subactions: destinationActions(new Set()) }]
          : [];
    const onAction = (id: string) => {
      if (item.kind === "group") {
        if (id === "create") nameGroup(item.group.id);
        if (id === "rename") nameGroup(item.group.parentId, item.group);
        if (id === "coordinate") void coordinate(item.group);
        if (id === "remove")
          Dialog.confirm({
            title: `Remove ${item.group.name}?`,
            message:
              "Projects, subgroups and coordination threads move up one level. No project or thread is deleted.",
            confirmText: "Remove group",
            destructive: true,
            onConfirm: () => {
              void controller.mutate({ type: "remove", groupId: item.group.id });
            },
          });
      }
      if (id === "move:root" || id.startsWith("move:group:")) {
        const parentId = id === "move:root" ? null : id.slice("move:group:".length);
        if (item.kind === "group")
          void controller.mutate({
            type: "move",
            groupId: item.group.id,
            parentId,
            beforeId: null,
          });
        if (item.kind === "project")
          void controller.mutate({
            type: "assignProjects",
            projectIds: [item.project.id],
            groupId: parentId,
          });
      }
    };
    return (
      <View
        className="flex-row items-center pr-2"
        style={{ paddingLeft: 16 + Math.min(item.depth, 8) * 16 }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={
            item.kind === "group" || item.kind === "project"
              ? { expanded: item.expanded }
              : { disabled: item.kind === "pending" && (!controller.canCoordinate || pending) }
          }
          disabled={item.kind === "pending" && (!controller.canCoordinate || pending)}
          onPress={onPress}
          className="min-h-12 flex-1 flex-row items-center gap-2 py-2"
        >
          <AppText className="text-foreground-muted">
            {item.kind === "group" || item.kind === "project"
              ? item.expanded
                ? "▾"
                : "▸"
              : item.kind === "pending"
                ? "↻"
                : item.coordination
                  ? "◇"
                  : "·"}
          </AppText>
          <AppText className="flex-1 text-foreground" numberOfLines={2}>
            {label}
          </AppText>
        </Pressable>
        {actions.length > 0 ? (
          <Menu actions={actions} onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}>
            <IconButton icon="ellipsis" accessibilityLabel={`Actions for ${label}`} />
          </Menu>
        ) : null}
      </View>
    );
  };
  return (
    <View className="flex-1">
      <View className="px-4 pb-2">
        <Button
          label="New group"
          size="compact"
          tone="text"
          disabled={disabled}
          onPress={() => nameGroup(null)}
        />
      </View>
      {controller.error ? (
        <View className="px-4 py-2">
          <AppText className="text-danger-foreground">{controller.error}</AppText>
          <Button label="Retry" tone="text" onPress={controller.refresh} />
        </View>
      ) : null}
      {snapshot && !writable ? (
        <AppText className="px-4 py-2 text-foreground-muted">
          Groups are read-only while disconnected or without editing permission.
        </AppText>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={renderRow}
        ListEmptyComponent={
          <AppText className="px-4 py-4 text-foreground-muted">
            {snapshot
              ? "Create a group, then use a project's menu to move it into the group."
              : "Loading groups…"}
          </AppText>
        }
      />
    </View>
  );
}

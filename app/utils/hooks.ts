import { useMemo } from "react";
import { useAccessStore, useAppConfig } from "../store";
import { collectModelsWithDefaultModel } from "./model";
import { channelCustomModels, sortChannelModels } from "./channel";

export function getAllModels() {
  const accessStore = useAccessStore.getState();
  const configStore = useAppConfig.getState();
  return sortChannelModels(
    collectModelsWithDefaultModel(
      configStore.models,
      [
        configStore.customModels,
        accessStore.customModels,
        channelCustomModels(configStore.channels),
      ].join(","),
      accessStore.defaultModel,
    ),
    configStore.channels,
  );
}

export function useAllModels() {
  const accessStore = useAccessStore();
  const configStore = useAppConfig();
  const models = useMemo(() => {
    return getAllModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    accessStore.customModels,
    accessStore.defaultModel,
    configStore.channels,
    configStore.customModels,
    configStore.models,
  ]);

  return models;
}

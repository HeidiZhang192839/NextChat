import { useMemo } from "react";
import { useAccessStore, useAppConfig } from "../store";
import { collectModelsWithDefaultModel } from "./model";
import { channelCustomModels } from "./channel";

export function useAllModels() {
  const accessStore = useAccessStore();
  const configStore = useAppConfig();
  const models = useMemo(() => {
    return collectModelsWithDefaultModel(
      configStore.models,
      [
        configStore.customModels,
        accessStore.customModels,
        channelCustomModels(configStore.channels),
      ].join(","),
      accessStore.defaultModel,
    );
  }, [
    accessStore.customModels,
    accessStore.defaultModel,
    configStore.channels,
    configStore.customModels,
    configStore.models,
  ]);

  return models;
}

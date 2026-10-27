import { useMemo, useState } from "react";
import { nanoid } from "nanoid";
import clsx from "clsx";

import styles from "./channel-config.module.scss";

import AddIcon from "../icons/add.svg";
import ClearIcon from "../icons/clear.svg";
import EditIcon from "../icons/edit.svg";
import ConfirmIcon from "../icons/confirm.svg";
import DownloadIcon from "../icons/download.svg";
import ResetIcon from "../icons/reload.svg";

import { IconButton } from "./button";
import {
  List,
  ListItem,
  Modal,
  PasswordInput,
  Select,
  showConfirm,
  showToast,
} from "./ui-lib";
import Locale from "../locales";
import { useAccessStore, useAppConfig } from "../store";
import { Channel } from "../store/config";
import { ApiPath, OPENAI_BASE_URL, OpenaiPath } from "../constant";
import { getClientConfig } from "../config/client";
import { collectModels } from "../utils/model";
import { fetch } from "../utils/stream";
import {
  channelHeaders,
  channelPath,
  validateChannelName,
} from "../utils/channel";
import { OpenAIListModelResponse } from "../client/platforms/openai";

const DEFAULT_CHANNEL_ID = "default";
const SITE_OPENAI_URL = getClientConfig()?.isApp
  ? OPENAI_BASE_URL
  : ApiPath.OpenAI;

// overrides the site endpoint in this browser via the existing custom endpoint config
function EditDefaultChannelModal(props: { onClose: () => void }) {
  const accessStore = useAccessStore();
  const custom = accessStore.useCustomConfig;
  const [url, setUrl] = useState(
    custom && accessStore.openaiUrl !== SITE_OPENAI_URL
      ? accessStore.openaiUrl
      : "",
  );
  const [apiKey, setApiKey] = useState(custom ? accessStore.openaiApiKey : "");

  const save = () => {
    accessStore.update((access) => {
      access.useCustomConfig = true;
      access.openaiUrl = url.trim() || SITE_OPENAI_URL;
      access.openaiApiKey = apiKey.trim();
    });
    props.onClose();
  };
  const reset = () => {
    accessStore.update((access) => {
      access.openaiUrl = SITE_OPENAI_URL;
      access.openaiApiKey = "";
    });
    props.onClose();
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Channel.DefaultModal.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            key="reset"
            icon={<ResetIcon />}
            text={Locale.Settings.Channel.DefaultModal.Reset}
            bordered
            onClick={reset}
          />,
          <IconButton
            key="save"
            icon={<ConfirmIcon />}
            text={Locale.Settings.Channel.EditModal.Save}
            type="primary"
            bordered
            onClick={save}
          />,
        ]}
      >
        <List>
          <ListItem
            title={Locale.Settings.Channel.EditModal.Url}
            subTitle={Locale.Settings.Channel.DefaultModal.UrlSubTitle}
          >
            <input
              type="text"
              value={url}
              placeholder={location.origin + ApiPath.OpenAI}
              onChange={(e) => setUrl(e.currentTarget.value)}
            ></input>
          </ListItem>
          <ListItem
            title={Locale.Settings.Channel.EditModal.ApiKey}
            subTitle={Locale.Settings.Channel.DefaultModal.ApiKeySubTitle}
          >
            <PasswordInput
              aria={Locale.Settings.Channel.EditModal.ApiKey}
              value={apiKey}
              type="text"
              placeholder="sk-..."
              onChange={(e) => setApiKey(e.currentTarget.value)}
            />
          </ListItem>
        </List>
      </Modal>
    </div>
  );
}

function EditChannelModal(props: { channel: Channel; onClose: () => void }) {
  const config = useAppConfig();
  const [draft, setDraft] = useState(props.channel);
  const others = config.channels.filter((c) => c.id !== draft.id);

  const save = () => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    const nameError = validateChannelName(name, others);
    if (nameError) {
      return showToast(Locale.Settings.Channel.EditModal.NameError[nameError]);
    }
    if (!url) {
      return showToast(Locale.Settings.Channel.EditModal.UrlError);
    }
    const channel = { ...draft, name, url };
    const exists = others.length < config.channels.length;
    config.update((config) => {
      config.channels = exists
        ? config.channels.map((c) => (c.id === channel.id ? channel : c))
        : config.channels.concat(channel);
    });
    props.onClose();
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Channel.EditModal.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            key="save"
            icon={<ConfirmIcon />}
            text={Locale.Settings.Channel.EditModal.Save}
            type="primary"
            bordered
            onClick={save}
          />,
        ]}
      >
        <List>
          <ListItem title={Locale.Settings.Channel.EditModal.Name}>
            <input
              type="text"
              value={draft.name}
              placeholder="My Channel"
              onChange={(e) =>
                setDraft({ ...draft, name: e.currentTarget.value })
              }
            ></input>
          </ListItem>
          <ListItem
            title={Locale.Settings.Channel.EditModal.Url}
            subTitle={Locale.Settings.Channel.EditModal.UrlSubTitle}
          >
            <input
              type="text"
              value={draft.url}
              placeholder="https://api.example.com"
              onChange={(e) =>
                setDraft({ ...draft, url: e.currentTarget.value })
              }
            ></input>
          </ListItem>
          <ListItem title={Locale.Settings.Channel.EditModal.ApiKey}>
            <PasswordInput
              aria={Locale.Settings.Channel.EditModal.ApiKey}
              value={draft.apiKey}
              type="text"
              placeholder="sk-..."
              onChange={(e) =>
                setDraft({ ...draft, apiKey: e.currentTarget.value })
              }
            />
          </ListItem>
        </List>
      </Modal>
    </div>
  );
}

function ChannelRow(props: {
  name: string;
  url: string;
  onEdit: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className={styles["channel-item"]}>
      <div className={styles["channel-header"]}>
        <div className={styles["channel-name"]}>{props.name}</div>
        <div className={styles["channel-url"]}>{props.url}</div>
      </div>
      <div className={styles["channel-buttons"]}>
        {props.onDelete && (
          <IconButton
            icon={<ClearIcon />}
            text={Locale.Settings.Channel.Modal.Delete}
            onClick={props.onDelete}
          />
        )}
        <IconButton
          icon={<EditIcon />}
          text={Locale.Settings.Channel.Modal.Edit}
          onClick={props.onEdit}
        />
      </div>
    </div>
  );
}

function ModelChecklist(props: {
  items: { key: string; name: string; hint?: string; checked: boolean }[];
  onToggle: (key: string, checked: boolean) => void;
  onAdd: (name: string) => void;
  actions?: JSX.Element;
}) {
  const [input, setInput] = useState("");
  const name = input.trim();
  const shown = props.items.filter((i) =>
    i.name.toLowerCase().includes(name.toLowerCase()),
  );
  const canAdd =
    name.length > 0 &&
    !/[,=]/.test(name) &&
    !props.items.some((i) => i.name === name);
  const add = () => {
    if (!canAdd) return;
    props.onAdd(name);
    setInput("");
  };

  return (
    <>
      <div className={styles["model-toolbar"]}>
        <input
          type="text"
          className={styles["model-search"]}
          placeholder={Locale.Settings.Channel.Models.Search}
          value={input}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        ></input>
        <IconButton
          icon={<AddIcon />}
          text={Locale.Settings.Channel.Models.Add}
          bordered
          disabled={!canAdd}
          onClick={add}
        />
        {props.actions}
      </div>
      <div className={styles.list}>
        {shown.length === 0 ? (
          <div className={styles.empty}>
            {Locale.Settings.Channel.Models.Empty}
          </div>
        ) : (
          shown.map((i) => (
            <label key={i.key} className={styles["model-item"]}>
              <input
                type="checkbox"
                checked={i.checked}
                onChange={(e) => props.onToggle(i.key, e.currentTarget.checked)}
              ></input>
              <span className={styles["model-name"]}>{i.name}</span>
              {i.hint && <span className={styles["model-hint"]}>{i.hint}</span>}
            </label>
          ))
        )}
      </div>
    </>
  );
}

// default channel visibility is stored as +/- entries in config.customModels,
// the same string as the "custom models" setting
function setModelToken(customModels: string, fullName: string, on: boolean) {
  return customModels
    .split(",")
    .filter((t) => t && t.replace(/^[+-]/, "") !== fullName)
    .concat(`${on ? "+" : "-"}${fullName}`)
    .join(",");
}

function DefaultChannelModels() {
  const config = useAppConfig();
  const accessStore = useAccessStore();
  const models = useMemo(
    () =>
      collectModels(
        config.models,
        [config.customModels, accessStore.customModels].join(","),
      ),
    [accessStore.customModels, config.customModels, config.models],
  );

  return (
    <ModelChecklist
      items={models.map((m) => ({
        key: `${m.name}@${m.provider?.id}`,
        name: m.displayName,
        hint: m.provider?.providerName,
        checked: m.available,
      }))}
      onToggle={(key, checked) =>
        config.update(
          (config) =>
            (config.customModels = setModelToken(
              config.customModels,
              key,
              checked,
            )),
        )
      }
      onAdd={(name) =>
        config.update(
          (config) =>
            (config.customModels = [config.customModels, `+${name}`]
              .filter((v) => v)
              .join(",")),
        )
      }
    />
  );
}

function ChannelModels(props: { channel: Channel }) {
  const config = useAppConfig();
  const { channel } = props;
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);

  const setModels = (models: string[]) =>
    config.update((config) => {
      const c = config.channels.find((c) => c.id === channel.id);
      if (c) c.models = models;
    });

  const fetchModels = async () => {
    setFetching(true);
    try {
      const res = await fetch(channelPath(channel, OpenaiPath.ListModelPath), {
        method: "GET",
        headers: channelHeaders(channel),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
      const json = (await res.json()) as OpenAIListModelResponse;
      setFetched(json.data.map((m) => m.id));
    } catch (e) {
      showToast(
        Locale.Settings.Channel.Models.FetchFailed((e as Error).message),
      );
    } finally {
      setFetching(false);
    }
  };

  const names = Array.from(new Set([...channel.models, ...fetched]));

  return (
    <ModelChecklist
      items={names.map((n) => ({
        key: n,
        name: n,
        checked: channel.models.includes(n),
      }))}
      onToggle={(name, checked) =>
        setModels(
          checked
            ? channel.models.concat(name)
            : channel.models.filter((m) => m !== name),
        )
      }
      onAdd={(name) => setModels(channel.models.concat(name))}
      actions={
        <IconButton
          icon={<DownloadIcon />}
          text={
            fetching
              ? Locale.Settings.Channel.Models.Fetching
              : Locale.Settings.Channel.Models.Fetch
          }
          bordered
          disabled={fetching}
          onClick={fetchModels}
        />
      }
    />
  );
}

export function ChannelConfigModal(props: { onClose: () => void }) {
  const config = useAppConfig();
  const accessStore = useAccessStore();
  const [tab, setTab] = useState<"channel" | "model">("channel");
  const [modelChannelId, setModelChannelId] = useState(DEFAULT_CHANNEL_ID);
  const [editingChannel, setEditingChannel] = useState<Channel>();
  const [editingDefault, setEditingDefault] = useState(false);

  const defaultUrl =
    accessStore.useCustomConfig && accessStore.openaiUrl
      ? accessStore.openaiUrl
      : SITE_OPENAI_URL;
  const modelChannel = config.channels.find((c) => c.id === modelChannelId);

  const deleteChannel = async (channel: Channel) => {
    if (
      await showConfirm(
        Locale.Settings.Channel.Modal.ConfirmDelete(channel.name),
      )
    ) {
      config.update(
        (config) =>
          (config.channels = config.channels.filter(
            (c) => c.id !== channel.id,
          )),
      );
    }
  };

  return (
    <div className="modal-mask">
      <Modal
        title={Locale.Settings.Channel.Modal.Title}
        onClose={props.onClose}
        actions={[
          <IconButton
            key="add"
            icon={<AddIcon />}
            text={Locale.Settings.Channel.Modal.Add}
            bordered
            onClick={() =>
              setEditingChannel({
                id: nanoid(),
                name: "",
                url: "",
                apiKey: "",
                models: [],
              })
            }
          />,
        ]}
      >
        <div className={styles["channel-modal"]}>
          <div className={styles.tabs}>
            {(["channel", "model"] as const).map((t) => (
              <div
                key={t}
                className={clsx(styles.tab, {
                  [styles["tab-active"]]: tab === t,
                })}
                onClick={() => setTab(t)}
              >
                {t === "channel"
                  ? Locale.Settings.Channel.Modal.ChannelTab
                  : Locale.Settings.Channel.Modal.ModelTab}
              </div>
            ))}
          </div>

          {tab === "channel" ? (
            <div className={styles.list}>
              <ChannelRow
                name={Locale.Settings.Channel.Modal.Default}
                url={
                  defaultUrl.startsWith("/")
                    ? location.origin + defaultUrl
                    : defaultUrl
                }
                onEdit={() => {
                  if (!accessStore.hideUserApiKey)
                    return setEditingDefault(true);
                  setModelChannelId(DEFAULT_CHANNEL_ID);
                  setTab("model");
                }}
              />
              {config.channels.map((c) => (
                <ChannelRow
                  key={c.id}
                  name={c.name}
                  url={c.url}
                  onEdit={() => setEditingChannel(c)}
                  onDelete={() => deleteChannel(c)}
                />
              ))}
            </div>
          ) : (
            <>
              <List>
                <ListItem title={Locale.Settings.Channel.Models.Channel}>
                  <Select
                    aria-label={Locale.Settings.Channel.Models.Channel}
                    value={modelChannel?.id ?? DEFAULT_CHANNEL_ID}
                    onChange={(e) => setModelChannelId(e.target.value)}
                  >
                    <option value={DEFAULT_CHANNEL_ID}>
                      {Locale.Settings.Channel.Modal.Default}
                    </option>
                    {config.channels.map((c) => (
                      <option value={c.id} key={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </ListItem>
              </List>
              {modelChannel ? (
                <ChannelModels key={modelChannel.id} channel={modelChannel} />
              ) : (
                <DefaultChannelModels />
              )}
            </>
          )}
        </div>
      </Modal>

      {editingChannel && (
        <EditChannelModal
          channel={editingChannel}
          onClose={() => setEditingChannel(undefined)}
        />
      )}
      {editingDefault && (
        <EditDefaultChannelModal onClose={() => setEditingDefault(false)} />
      )}
    </div>
  );
}

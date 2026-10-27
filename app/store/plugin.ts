import OpenAPIClientAxios from "openapi-client-axios";
import { StoreKey } from "../constant";
import { nanoid } from "nanoid";
import { createPersistStore } from "../utils/store";
import { getClientConfig } from "../config/client";
import yaml from "js-yaml";
import { adapter, getOperationId } from "../utils";
import { useAccessStore } from "./access";
import { useAppConfig } from "./config";
import { getClientApi, getHeaders } from "../client/api";

const isApp = getClientConfig()?.isApp !== false;

export type Plugin = {
  id: string;
  createdAt: number;
  title: string;
  version: string;
  content: string;
  builtin: boolean;
  authType?: string;
  authLocation?: string;
  authHeader?: string;
  authToken?: string;
};

export type FunctionToolItem = {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters: Object;
  };
};

type FunctionToolServiceItem = {
  api: OpenAPIClientAxios;
  length: number;
  tools: FunctionToolItem[];
  funcs: Record<string, Function>;
};

export const FunctionToolService = {
  tools: {} as Record<string, FunctionToolServiceItem>,
  add(plugin: Plugin, replace = false) {
    if (!replace && this.tools[plugin.id]) return this.tools[plugin.id];
    const headerName = (
      plugin?.authType == "custom" ? plugin?.authHeader : "Authorization"
    ) as string;
    const tokenValue =
      plugin?.authType == "basic"
        ? `Basic ${plugin?.authToken}`
        : plugin?.authType == "bearer"
        ? `Bearer ${plugin?.authToken}`
        : plugin?.authToken;
    const authLocation = plugin?.authLocation || "header";
    const definition = yaml.load(plugin.content) as any;
    const serverURL = definition?.servers?.[0]?.url;
    const baseURL = !isApp ? "/api/proxy" : serverURL;
    const headers: Record<string, string | undefined> = {
      "X-Base-URL": !isApp ? serverURL : undefined,
    };
    if (authLocation == "header") {
      headers[headerName] = tokenValue;
    }
    // try using openaiApiKey for Dalle3 Plugin.
    if (!tokenValue && plugin.id === "dalle3") {
      const openaiApiKey = useAccessStore.getState().openaiApiKey;
      if (openaiApiKey) {
        headers[headerName] = `Bearer ${openaiApiKey}`;
      }
    }
    const api = new OpenAPIClientAxios({
      definition: yaml.load(plugin.content) as any,
      axiosConfigDefaults: {
        adapter: (window.__TAURI__ ? adapter : ["xhr"]) as any,
        baseURL,
        headers,
      },
    });
    try {
      api.initSync();
    } catch (e) {}
    const operations = api.getOperations();
    return (this.tools[plugin.id] = {
      api,
      length: operations.length,
      tools: operations.map((o) => {
        // @ts-ignore
        const parameters = o?.requestBody?.content["application/json"]
          ?.schema || {
          type: "object",
          properties: {},
        };
        if (!parameters["required"]) {
          parameters["required"] = [];
        }
        if (o.parameters instanceof Array) {
          o.parameters.forEach((p) => {
            // @ts-ignore
            if (p?.in == "query" || p?.in == "path") {
              // const name = `${p.in}__${p.name}`
              // @ts-ignore
              const name = p?.name;
              parameters["properties"][name] = {
                // @ts-ignore
                type: p.schema.type,
                // @ts-ignore
                description: p.description,
              };
              // @ts-ignore
              if (p.required) {
                parameters["required"].push(name);
              }
            }
          });
        }
        return {
          type: "function",
          function: {
            name: getOperationId(o),
            description: o.description || o.summary,
            parameters: parameters,
          },
        } as FunctionToolItem;
      }),
      funcs: operations.reduce((s, o) => {
        // @ts-ignore
        s[getOperationId(o)] = function (args) {
          const parameters: Record<string, any> = {};
          if (o.parameters instanceof Array) {
            o.parameters.forEach((p) => {
              // @ts-ignore
              parameters[p?.name] = args[p?.name];
              // @ts-ignore
              delete args[p?.name];
            });
          }
          if (authLocation == "query") {
            parameters[headerName] = tokenValue;
          } else if (authLocation == "body") {
            args[headerName] = tokenValue;
          }
          // @ts-ignore if o.operationId is null, then using o.path and o.method
          return api.client.paths[o.path][o.method](
            parameters,
            args,
            api.axiosConfigDefaults,
          );
        };
        return s;
      }, {}),
    });
  },
  get(id: string) {
    return this.tools[id];
  },
};

// built-in web search tool, backed by /api/search (SearXNG)
export const WEB_SEARCH_PLUGIN_ID = "websearch";

async function summarizeChunk(chunk: string, question?: string) {
  // dynamic import: ./chat imports this file
  const { useChatStore } = await import("./chat");
  const { model, providerName } = useChatStore.getState().currentSession()
    .mask.modelConfig;
  const prompt = [
    "Summarize the following web page content. Keep all concrete facts, numbers, names, dates, code and link urls that could be useful, and drop navigation and boilerplate.",
    question ? `Focus on information relevant to: ${question}` : "",
    "Content:",
    chunk,
  ].join("\n\n");
  return new Promise<string>((resolve, reject) =>
    getClientApi(providerName).llm.chat({
      messages: [{ role: "user", content: prompt }],
      config: { model, providerName, stream: false },
      onFinish: (message, res) => {
        if (res?.status === 200) return resolve(message);
        // the error body comes back as the message
        const tooLong =
          (res?.status === 400 || res?.status === 413) &&
          /context|too long|too large|maximum|exceed/i.test(message);
        reject(
          Object.assign(new Error(`summarize failed: ${res?.status}`), {
            tooLong,
          }),
        );
      },
      onError: reject,
    }),
  );
}

// summarize the text in one request; if it is too long for the model's
// context, split it in half and summarize each half the same way
async function summarizeText(text: string, question?: string): Promise<string> {
  try {
    return await summarizeChunk(text, question);
  } catch (e: any) {
    if (!e?.tooLong || text.length < 2000) throw e;
    let mid = text.lastIndexOf("\n", text.length / 2);
    if (mid <= 0) mid = Math.floor(text.length / 2);
    const halves = await Promise.all([
      summarizeText(text.slice(0, mid), question),
      summarizeText(text.slice(mid), question),
    ]);
    return halves.join("\n\n");
  }
}

async function fetchWebpage(args: { url: string; question?: string }) {
  const res = await fetch(
    `/api/fetch-page?url=${encodeURIComponent(args.url)}`,
    { headers: getHeaders() },
  );
  const result = { status: res.status, statusText: res.statusText };
  if (!res.ok) return { ...result, data: await res.text() };

  const page = await res.json();
  // pages longer than this are summarized by the chat's own model before being returned
  const maxChars = Math.max(1000, useAppConfig.getState().webPageMaxChars);
  if (page.content.length > maxChars) {
    try {
      let content = page.content;
      // joined summaries of many halves can still be over the limit, so repeat
      while (content.length > maxChars) {
        const summary = await summarizeText(content, args.question);
        if (summary.length >= content.length) break;
        content = summary;
      }
      page.content = content.slice(0, maxChars);
      page.summarized = true;
    } catch (e) {
      // fall back to the beginning of the page
      page.content = page.content.slice(0, maxChars);
      page.truncated = true;
    }
  }
  return { ...result, data: JSON.stringify(page) };
}

const WebSearchTool = {
  tools: [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the internet for up-to-date information. Returns a list of results with title, url and content snippet.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "The search query" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_webpage",
        description:
          "Fetch a web page or PDF and return its full text content (very long pages are returned as a summary). Links appear as `text [url]`, and you can fetch those urls too, e.g. to read a linked PDF. Use it on urls from web_search results when the snippet is not enough.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The url of the page" },
            question: {
              type: "string",
              description:
                "What you are looking for on the page, so a summary of a long page keeps the relevant parts",
            },
          },
          required: ["url"],
        },
      },
    },
  ] as FunctionToolItem[],
  funcs: {
    web_search: (args: { query: string }) =>
      fetch(`/api/search?q=${encodeURIComponent(args.query)}`, {
        headers: getHeaders(),
      }).then(async (res) => ({
        status: res.status,
        statusText: res.statusText,
        data: await res.text(),
      })),
    fetch_webpage: fetchWebpage,
  } as Record<string, Function>,
};

export const createEmptyPlugin = () =>
  ({
    id: nanoid(),
    title: "",
    version: "1.0.0",
    content: "",
    builtin: false,
    createdAt: Date.now(),
  }) as Plugin;

export const DEFAULT_PLUGIN_STATE = {
  plugins: {} as Record<string, Plugin>,
};

export const usePluginStore = createPersistStore(
  { ...DEFAULT_PLUGIN_STATE },

  (set, get) => ({
    create(plugin?: Partial<Plugin>) {
      const plugins = get().plugins;
      const id = plugin?.id || nanoid();
      plugins[id] = {
        ...createEmptyPlugin(),
        ...plugin,
        id,
        builtin: false,
      };

      set(() => ({ plugins }));
      get().markUpdate();

      return plugins[id];
    },
    updatePlugin(id: string, updater: (plugin: Plugin) => void) {
      const plugins = get().plugins;
      const plugin = plugins[id];
      if (!plugin) return;
      const updatePlugin = { ...plugin };
      updater(updatePlugin);
      plugins[id] = updatePlugin;
      FunctionToolService.add(updatePlugin, true);
      set(() => ({ plugins }));
      get().markUpdate();
    },
    delete(id: string) {
      const plugins = get().plugins;
      delete plugins[id];
      set(() => ({ plugins }));
      get().markUpdate();
    },

    getAsTools(ids: string[]) {
      const plugins = get().plugins;
      const selected = [
        ...((ids || []).includes(WEB_SEARCH_PLUGIN_ID) ? [WebSearchTool] : []),
        ...(ids || [])
          .map((id) => plugins[id])
          .filter((i) => i)
          .map((p) => FunctionToolService.add(p)),
      ];
      return [
        // @ts-ignore
        selected.reduce((s, i) => s.concat(i.tools), []),
        selected.reduce((s, i) => Object.assign(s, i.funcs), {}),
      ];
    },
    get(id?: string) {
      return get().plugins[id ?? 1145141919810];
    },
    getAll() {
      return Object.values(get().plugins).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
    },
  }),
  {
    name: StoreKey.Plugin,
    version: 1,
    onRehydrateStorage(state) {
      // Skip store rehydration on server side
      if (typeof window === "undefined") {
        return;
      }

      fetch("./plugins.json")
        .then((res) => res.json())
        .then((res) => {
          Promise.all(
            res.map((item: any) =>
              // skip get schema
              state.get(item.id)
                ? item
                : fetch(item.schema)
                    .then((res) => res.text())
                    .then((content) => ({
                      ...item,
                      content,
                    }))
                    .catch((e) => item),
            ),
          ).then((builtinPlugins: any) => {
            builtinPlugins
              .filter((item: any) => item?.content)
              .forEach((item: any) => {
                const plugin = state.create(item);
                state.updatePlugin(plugin.id, (plugin) => {
                  const tool = FunctionToolService.add(plugin, true);
                  plugin.title = tool.api.definition.info.title;
                  plugin.version = tool.api.definition.info.version;
                  plugin.builtin = true;
                });
              });
          });
        });
    },
  },
);

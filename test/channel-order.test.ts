/**
 * @jest-environment node
 */
import { useAppConfig } from "../app/store";
import { Channel } from "../app/store/config";
import { getAllModels } from "../app/utils/hooks";

const channel = (name: string, models: string[]): Channel => ({
  id: name,
  name,
  url: "https://example.com",
  apiKey: "",
  models,
});

const channelModels = () =>
  getAllModels()
    .filter((m) => m.provider?.providerType === "custom")
    .map((m) => `${m.name}@${m.provider?.providerName}`);

describe("channel order in the model list", () => {
  test("models follow the channels when they are reordered", () => {
    const a = channel("ChanA", ["a1", "a2"]);
    const b = channel("ChanB", ["b1"]);
    const c = channel("ChanC", ["c1", "c2"]);

    useAppConfig.setState({ channels: [a, b, c] });
    expect(channelModels()).toEqual([
      "a1@ChanA",
      "a2@ChanA",
      "b1@ChanB",
      "c1@ChanC",
      "c2@ChanC",
    ]);

    useAppConfig.setState({ channels: [c, a, b] });
    expect(channelModels()).toEqual([
      "c1@ChanC",
      "c2@ChanC",
      "a1@ChanA",
      "a2@ChanA",
      "b1@ChanB",
    ]);
  });

  test("models follow the order inside a channel", () => {
    useAppConfig.setState({ channels: [channel("ChanD", ["d1", "d2"])] });
    expect(channelModels()).toEqual(["d1@ChanD", "d2@ChanD"]);

    useAppConfig.setState({ channels: [channel("ChanD", ["d2", "d1"])] });
    expect(channelModels()).toEqual(["d2@ChanD", "d1@ChanD"]);
  });

  test("other models keep their places", () => {
    useAppConfig.setState({ channels: [] });
    const builtin = getAllModels().map((m) => `${m.name}@${m.provider?.id}`);

    useAppConfig.setState({
      channels: [channel("ChanF", ["f1"]), channel("ChanE", ["e1"])],
    });
    const all = getAllModels();
    expect(all.slice(0, 2).map((m) => m.name)).toEqual(["f1", "e1"]);
    expect(all.slice(2).map((m) => `${m.name}@${m.provider?.id}`)).toEqual(
      builtin,
    );
  });

  test("malformed channel model lists do not break model discovery", () => {
    useAppConfig.setState({
      channels: [
        channel("Valid", ["v1"]),
        { ...channel("Legacy", []), models: "m1,m2" as unknown as string[] },
        { ...channel("Invalid", []), models: null as unknown as string[] },
      ],
    });

    expect(channelModels()).toEqual(["v1@Valid", "m1@Legacy", "m2@Legacy"]);
  });
});

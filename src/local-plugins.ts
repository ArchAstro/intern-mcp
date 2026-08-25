import type { CurrentUser } from "@archastro/intern-sdk";
import { MemoryMeImplementation } from "@archastro/intern-sdk/testing";
import type { SitePluginInstallation } from "./api.js";
import { LocalD1 } from "./local-d1.js";

export type LocalPlugin = Readonly<
  Record<string, (input: unknown) => Promise<unknown>>
>;

interface LocalPluginInstance {
  readonly operations: LocalPlugin;
  close?(): void;
}

interface LocalPluginDescriptor {
  readonly plugin: string;
  create(installation: SitePluginInstallation, user: CurrentUser): LocalPluginInstance;
}

const descriptors: readonly LocalPluginDescriptor[] = [
  {
    plugin: "me",
    create: (_installation, user) => {
      const implementation = new MemoryMeImplementation(user);
      return {
        operations: {
          get: () => implementation.get(),
          update: (input) =>
            implementation.update(input as Parameters<typeof implementation.update>[0]),
        },
      };
    },
  },
  {
    plugin: "d1",
    create: () => {
      const implementation = new LocalD1();
      return {
        operations: {
          query: (input) =>
            implementation.query(input as Parameters<typeof implementation.query>[0]),
          batch: (input) =>
            implementation.batch(input as Parameters<typeof implementation.batch>[0]),
          exec: (input) =>
            implementation.exec(input as Parameters<typeof implementation.exec>[0]),
        },
        close: () => implementation.close(),
      };
    },
  },
];

export interface LocalPluginSet {
  readonly operations: ReadonlyMap<string, LocalPlugin>;
  close(): void;
}

export function createLocalPluginSet(
  installations: readonly SitePluginInstallation[],
  user: CurrentUser,
): LocalPluginSet {
  const byPlugin = new Map(
    descriptors.map((descriptor) => [descriptor.plugin, descriptor]),
  );
  const operations = new Map<string, LocalPlugin>();
  const instances: LocalPluginInstance[] = [];
  try {
    for (const installation of installations) {
      if (installation.state !== "active") continue;
      const descriptor = byPlugin.get(installation.plugin);
      if (!descriptor) continue;
      if (operations.has(installation.binding)) {
        throw new Error(`duplicate local plugin binding: ${installation.binding}`);
      }
      const instance = descriptor.create(installation, user);
      instances.push(instance);
      operations.set(installation.binding, instance.operations);
    }
  } catch (error) {
    for (const instance of instances.reverse()) instance.close?.();
    throw error;
  }
  return {
    operations,
    close() {
      for (const instance of instances.reverse()) instance.close?.();
    },
  };
}

import fs from "fs/promises";
import path from "path";
import os from "os";
import { AuthInfo } from "./types.js";

export class AuthStorage {
  private static readonly AUTH_FILE = path.join(
    os.homedir(),
    ".local",
    "share",
    "openagent",
    "auth.json"
  );

  private static async ensureDir() {
    const dir = path.dirname(this.AUTH_FILE);
    await fs.mkdir(dir, { recursive: true });
  }

  static async get(providerID: string): Promise<AuthInfo | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content);
      return data[providerID] as AuthInfo | undefined;
    } catch {
      return undefined;
    }
  }


  static async all(): Promise<Record<string, AuthInfo>> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  static async set(providerID: string, info: AuthInfo): Promise<void> {
    await this.ensureDir();
    const data = await this.all();
    data[providerID] = info;
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
    // Set file permissions to user read/write only
    await fs.chmod(this.AUTH_FILE, 0o600);
  }

  static async remove(providerID: string): Promise<void> {
    const data = await this.all();
    delete data[providerID];
    await this.ensureDir();
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
  }

  static getFilePath(): string {
    return this.AUTH_FILE;
  }
}
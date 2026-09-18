import type { PiDesktopBridge } from "../../shared/ipc.ts";

declare global {
	interface Window {
		piDesktop: PiDesktopBridge;
	}
}

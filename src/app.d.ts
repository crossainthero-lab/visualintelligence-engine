declare global {
	namespace App {
		interface Locals {
			actor: 'ui' | 'collector' | 'mcp';
			collectorId?: string;
		}
	}
}
export {};

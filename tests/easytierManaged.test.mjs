import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEasyTierPeers, sanitizeEasyTierNetworkName, sanitizeEasyTierNetworkSecret } from "../src/shared/easytierPeers.ts";
import { buildEasyTierToml, isEasyTierConfigReady, parseScQuery } from "../src/main/web/remoteAccess/easytierService.ts";

test("sanitizeEasyTierPeers 补协议、去重、丢弃非法条目", () => {
	const peers = sanitizeEasyTierPeers(["1.2.3.4:11010", "tcp://1.2.3.4:11010", "udp://[2001:db8::1]:11010", "not a peer", "", 42, "ws://host:11010/path"]);
	// 裸 host:port 与显式 tcp:// 归一后去重；带路径的 ws 地址不合法被丢弃
	assert.deepEqual(peers, ["tcp://1.2.3.4:11010", "udp://[2001:db8::1]:11010"]);
});

test("sanitizeEasyTierPeers 拒绝端口越界并限制条数", () => {
	assert.deepEqual(sanitizeEasyTierPeers(["tcp://1.2.3.4:0"]), []);
	assert.deepEqual(sanitizeEasyTierPeers(["tcp://1.2.3.4:70000"]), []);
	const many = Array.from({ length: 30 }, (_, index) => `tcp://10.0.0.${index + 1}:11010`);
	assert.equal(sanitizeEasyTierPeers(many).length, 16);
	assert.deepEqual(sanitizeEasyTierPeers(undefined), []);
});

test("sanitizeEasyTierNetworkName/Secret 去空白并拒绝控制字符", () => {
	assert.equal(sanitizeEasyTierNetworkName("  caoayu  "), "caoayu");
	assert.equal(sanitizeEasyTierNetworkName("我的网络"), "我的网络");
	assert.equal(sanitizeEasyTierNetworkName("bad\nname"), "");
	assert.equal(sanitizeEasyTierNetworkSecret("  xRwXwDK8fZ1mEs1wBbNF "), "xRwXwDK8fZ1mEs1wBbNF");
	assert.equal(sanitizeEasyTierNetworkSecret(""), "");
});

test("buildEasyTierToml 输出 core 可解析的字段", () => {
	const toml = buildEasyTierToml({ networkName: "caoayu", networkSecret: "secret-1", peers: ["tcp://1.2.3.4:11010"], bindIpv4: "", instanceName: "caoayu" });
	assert.match(toml, /^dhcp = true$/m);
	assert.match(toml, /^\[network_identity\]$/m);
	assert.match(toml, /^network_name = "caoayu"$/m);
	assert.match(toml, /^network_secret = "secret-1"$/m);
	assert.match(toml, /^\[\[peer\]\]$/m);
	assert.match(toml, /^uri = "tcp:\/\/1\.2\.3\.4:11010"$/m);
	assert.doesNotMatch(toml, /^ipv4 = /m);
});

test("buildEasyTierToml 指定固定 IP 时关闭 dhcp 并转义引号", () => {
	const toml = buildEasyTierToml({ networkName: 'a"b', networkSecret: "s\\x", peers: [], bindIpv4: "10.126.126.1", instanceName: "inst" });
	assert.match(toml, /^dhcp = false$/m);
	assert.match(toml, /^ipv4 = "10\.126\.126\.1"$/m);
	// TOML 基本字符串：双引号与反斜杠都要转义，否则配置解析失败
	assert.match(toml, /^network_name = "a\\"b"$/m);
	assert.match(toml, /^network_secret = "s\\\\x"$/m);
});

test("isEasyTierConfigReady 要求网络名与密钥同时存在", () => {
	assert.equal(isEasyTierConfigReady({ networkName: "a", networkSecret: "b" }), true);
	assert.equal(isEasyTierConfigReady({ networkName: "a", networkSecret: "  " }), false);
	assert.equal(isEasyTierConfigReady({ networkName: "", networkSecret: "b" }), false);
	assert.equal(isEasyTierConfigReady(null), false);
});

test("parseScQuery 识别未安装与运行中", () => {
	assert.deepEqual(parseScQuery("", "系统找不到指定的服务。 1060"), { installed: false, running: false });
	assert.deepEqual(parseScQuery("", "The specified service does not exist as an installed service."), { installed: false, running: false });
	const running = "SERVICE_NAME: easytier\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING";
	assert.deepEqual(parseScQuery(running), { installed: true, running: true });
	const stopped = "SERVICE_NAME: easytier\n        STATE              : 1  STOPPED";
	assert.deepEqual(parseScQuery(stopped), { installed: true, running: false });
});

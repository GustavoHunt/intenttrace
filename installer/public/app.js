const $ = (id) => document.getElementById(id);
let receipt,
  phases = [],
  running = false;
const message = (text) => {
  $("message").textContent = text || "";
};
async function api(path, body) {
  const r = await fetch(
    `/api/${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  let data;
  try {
    data = await r.json();
  } catch {
    throw new Error(
      "The connection was interrupted. Retry this step; saved progress is preserved.",
    );
  }
  if (!r.ok) {
    const error = new Error(
      data.error || "The connection failed. Please retry.",
    );
    error.status = r.status;
    throw error;
  }
  return data;
}
function render(data) {
  receipt = data.receipt || receipt;
  $("connect").hidden = Boolean(
    receipt?.phase === phases.length || (data.connected && !receipt?.error),
  );
  $("connect-button").textContent = receipt
    ? "Reconnect Cloudflare"
    : "Connect Cloudflare";
  $("account-panel").hidden = !data.connected || Boolean(receipt);
  $("disconnect").hidden = !data.connected || running;
  if (data.accounts && !receipt) {
    $("account").replaceChildren(
      ...data.accounts.map((a) => {
        const o = document.createElement("option");
        o.value = a.id;
        o.textContent = a.name;
        return o;
      }),
    );
    $("install").disabled = !data.accounts.length;
  }
  if (!receipt) return;
  $("progress").hidden = false;
  $("steps").replaceChildren(
    ...phases.map((phase, i) => {
      const li = document.createElement("li");
      li.textContent = phase;
      li.dataset.state =
        i < receipt.phase ? "done" : i === receipt.phase ? "active" : "waiting";
      const status = document.createElement("span");
      status.textContent =
        i < receipt.phase
          ? "Complete"
          : i === receipt.phase
            ? receipt.error
              ? "Needs attention"
              : running
                ? "In progress"
                : "Ready"
            : "Waiting";
      li.append(status);
      return li;
    }),
  );
  message(receipt.error);
  $("retry").hidden = running || receipt.phase >= phases.length;
  $("update").hidden = running || receipt.phase !== 9;
  $("help").hidden = !receipt.helpUrl;
  if (receipt.helpUrl) $("help").href = receipt.helpUrl;
  $("receipt").hidden = false;
  $("open").hidden = receipt.phase < phases.length;
  if (receipt.url) $("open").href = receipt.url;
  $("revocation").textContent =
    receipt.phase === phases.length
      ? data.accessRevoked
        ? "Installation verified. Cloudflare access has been revoked. Your app runs independently."
        : "Installation verified. Disconnect Cloudflare to finish revoking installer access."
      : "You can safely retry an interrupted step in this session.";
}
async function steps() {
  if (running) return;
  running = true;
  render({ connected: true });
  let failure;
  try {
    while (receipt.phase < phases.length) {
      const previous = receipt.phase;
      const data = await api("step", {});
      render(data);
      if (data.receipt.error) break;
      if (receipt.phase === previous)
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } catch (e) {
    failure = e.message;
  } finally {
    running = false;
    const data = await api("status").catch(() => ({ connected: true }));
    render(data);
    if (failure) message(failure);
  }
}
$("install").onclick = async () => {
  $("install").disabled = true;
  try {
    render(await api("install", { accountId: $("account").value }));
    await steps();
  } catch (e) {
    message(e.message);
  } finally {
    $("install").disabled = false;
  }
};
$("retry").onclick = steps;
$("update").onclick = async () => {
  try {
    render(await api("update", {}));
    await steps();
  } catch (e) {
    message(e.message);
  }
};
$("disconnect").onclick = async () => {
  try {
    await api("disconnect", {});
    render({ connected: false, accessRevoked: true });
    message(
      "Cloudflare disconnected. Created resources remain in your account.",
    );
  } catch (e) {
    message(e.message);
  }
};
$("receipt").onclick = () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "intenttrace-installation.json";
  a.click();
  URL.revokeObjectURL(url);
};
async function init() {
  try {
    const config = await api("config");
    phases = config.phases;
    $("connect-button").disabled = !config.configured;
    if (!config.configured) {
      message(
        "The installer is ready locally. Its owner must configure the Cloudflare OAuth client before accounts can connect. See the installation guide in the repository.",
      );
      return;
    }
    const data = await api("status").catch((error) => {
      if (error.status === 401) return { connected: false };
      throw error;
    });
    render(data);
    const state = new URLSearchParams(location.search).get("connection");
    if (state) {
      message(
        state === "cancelled"
          ? "Cloudflare authorization was cancelled. Any resources created earlier are preserved."
          : new URLSearchParams(location.search).get("reason") ||
              "Sign-in could not be verified. Please connect again.",
      );
      history.replaceState(null, "", "/");
    }
  } catch (e) {
    message(e.message);
  }
}
init();

// Login + registration pages.
(function () {
  const { api, session, esc } = window.RIQ;
  const notice = document.getElementById("formNotice");
  const show = (message, type = "error") => { notice.innerHTML = message ? `<div class="notice ${type}">${esc(message)}</div>` : ""; };

  if (session.get()?.token) {
    api.get("/auth/me").then(() => location.replace("index.html")).catch(() => session.clear());
  }
  if (new URLSearchParams(location.search).get("expired")) show("Your session ended. Please log in again.", "warn");
  if (new URLSearchParams(location.search).get("loggedout")) show("You have been logged out.", "ok");

  async function submit(form, path, validate) {
    const data = Object.fromEntries(new FormData(form).entries());
    const problem = validate(data);
    if (problem) return show(problem);
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    show("");
    try {
      const result = await api.post(path, data);
      session.set(result);
      location.replace("index.html");
    } catch (error) {
      show(error.message);
      button.disabled = false;
    }
  }

  const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || "").trim());

  document.getElementById("loginForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(event.currentTarget, "/auth/login", (d) => (!emailOk(d.email) ? "Enter a valid email address." : !d.password ? "Enter your password." : null));
  });

  document.getElementById("registerForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    submit(event.currentTarget, "/auth/register", (d) => {
      if (!d.name.trim()) return "Enter your name.";
      if (!emailOk(d.email)) return "Enter a valid email address.";
      if (d.password.length < 8 || !/[A-Za-z]/.test(d.password) || !/\d/.test(d.password)) return "Password must be at least 8 characters and include a letter and a number.";
      return null;
    });
  });
})();

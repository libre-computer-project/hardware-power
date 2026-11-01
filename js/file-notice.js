/* Opened from a file:// path, the page cannot fetch its board index (and the
   module that would report that does not load). A classic script, not
   inline: the page's Content-Security-Policy runs no inline script but the
   theme snippet. */
if (location.protocol === "file:") {
  var host = document.getElementById("notices");
  var note = document.createElement("p");
  note.className = "lc-notice";
  note.setAttribute("role", "status");
  note.textContent = "Could not load the board index. If you are opening this from a file:// path, serve the directory over HTTP instead — python3 -m http.server.";
  host.appendChild(note);
}

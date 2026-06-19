let fuse;
let entries = [];

fetch("dictionary.json")
  .then(r => r.json())
  .then(data => {

    entries = data.entries;

    fuse = new Fuse(entries, {
      keys: [
        "headword"
      ],
      threshold: 0.3,
      ignoreLocation: true
    });

    showEntries(entries);
  });

function showEntries(items) {

  const results = document.getElementById("results");

  results.innerHTML = items.map(entry => `
    <div class="entry">

      <div class="headwords">
        ${entry.headword.join(", ")}
      </div>

      ${entry.note
        ? `<div class="note">${entry.note}</div>`
        : ""}

      <div class="sign">
        ${entry.sign}
      </div>

    </div>
  `).join("");
}

document
  .getElementById("search")
  .addEventListener("input", function () {

    const q = this.value.trim();

    if (q === "") {
      showEntries(entries);
      return;
    }

    const matches = fuse.search(q);

    showEntries(
      matches.map(m => m.item)
    );
  });

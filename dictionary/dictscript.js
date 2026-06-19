let entries = [];
let fuse;

fetch("dictionary.json")
    .then(response => response.json())
    .then(data => {

        entries = data.entries.map(entry => ({
            ...entry,
            headwordText: entry.headword.join(" ")
        }));

        fuse = new Fuse(entries, {
            keys: [
                "headwordText",
                "sign",
                "note"
            ],
            threshold: 0.3,
            ignoreLocation: true
        });

        displayEntries(entries);
    })
    .catch(error => {
        console.error(error);
        document.getElementById("results").innerHTML =
            "<p>Error loading dictionary.</p>";
    });

function displayEntries(items) {

    const results = document.getElementById("results");

    if (items.length === 0) {
        results.innerHTML = "<p>No matches found.</p>";
        return;
    }

    results.innerHTML = items.map(entry => `

        <div class="entry">

            <div class="headword">
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

        const query = this.value.trim();

        if (query === "") {
            displayEntries(entries);
            return;
        }

        const matches = fuse.search(query);

        displayEntries(
            matches
                .slice(0, 50)
                .map(match => match.item)
        );
    });

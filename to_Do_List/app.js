const inputBox = document.getElementById("input_box");
const listContainer = document.getElementById("list_container");
const addButton = document.querySelector("button");

window.addEventListener("load", loadTasks);

function addTask() {
  const trimmedText = inputBox.value.replace(/\s/g, "");

  if (!trimmedText) {
    alert("You must write something!");
    return;
  }

  const li = document.createElement("li");

  const checkSpan = document.createElement("span");
  checkSpan.className = "checkmark";

  const textNode = document.createTextNode(inputBox.value);

  const deleteBtn = document.createElement("span");
  deleteBtn.className = "delete-btn";
  deleteBtn.innerHTML = "✖";

  li.appendChild(checkSpan);
  li.appendChild(textNode);
  li.appendChild(deleteBtn);

  listContainer.appendChild(li);
  inputBox.value = "";

  saveTasks();
}

addButton.addEventListener("click", addTask);

inputBox.addEventListener("keypress", function (e) {
  if (e.key === "Enter") {
    addTask();
  }
});

listContainer.addEventListener("click", function (e) {
  if (e.target.classList.contains("checkmark")) {
    e.target.closest("li").classList.toggle("checked");
    saveTasks();
  }

  if (e.target.classList.contains("delete-btn")) {
    e.target.closest("li").remove();
    saveTasks();
  }
});

function saveTasks() {
  const tasks = [];

  listContainer.querySelectorAll("li").forEach((li) => {
    tasks.push({
      text: li.childNodes[1].nodeValue,
      checked: li.classList.contains("checked"),
    });
  });

  localStorage.setItem("tasks", JSON.stringify(tasks));
}

function loadTasks() {
  const stored = localStorage.getItem("tasks");

  if (stored) {
    const tasks = JSON.parse(stored);

    tasks.forEach((task) => {
      const li = document.createElement("li");

      const checkSpan = document.createElement("span");
      checkSpan.className = "checkmark";

      const textNode = document.createTextNode(task.text);

      const deleteBtn = document.createElement("span");
      deleteBtn.className = "delete-btn";
      deleteBtn.innerHTML = "✖";

      li.appendChild(checkSpan);
      li.appendChild(textNode);
      li.appendChild(deleteBtn);

      if (task.checked) li.classList.add("checked");

      listContainer.appendChild(li);
    });
  }
}

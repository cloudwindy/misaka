function delay(time) {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            resolve();
        }, time);
    });
}

function responsive() {
    var x = document.getElementsByTagName("nav")[0];
    if (x.className === "") {
        x.className = "responsive";
    } else {
        x.className = "";
    }
}
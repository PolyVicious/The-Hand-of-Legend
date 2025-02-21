document.addEventListener("DOMContentLoaded", function () {
    // Get the fixed navbar's height
    const navbar = document.querySelector("#mainNav");
    const navbarHeight = navbar ? navbar.offsetHeight : 0;

    // Select all anchor links starting with #
    const links = document.querySelectorAll('a[href^="#"]');

    // Add click event to each link
    links.forEach(link => {
        link.addEventListener("click", function (event) {
            const targetId = this.getAttribute("href").substring(1); // Get the ID of the target section
            const targetElement = document.getElementById(targetId);

            if (targetElement) {
                event.preventDefault(); // Prevent default anchor behavior
                const offsetPosition = targetElement.offsetTop - navbarHeight; // Calculate scroll position
                window.scrollTo({
                    top: offsetPosition, // Scroll to the target position
                    behavior: "smooth" // Smooth scrolling
                });
            }
        });
    });
});
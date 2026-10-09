const nameR = document.getElementById('name');
const ageR = document.getElementById('age');
const emailR = document.getElementById('email');
const passwordR = document.getElementById('password');
const passwordRepit = document.getElementById('Repitpassword');
const actionRegister = document.getElementById('regiteering');

actionRegister.addEventListener('click', async () => {
    try {
        const userName = nameR.value;
        const userAge = ageR.value;
        const userEmail = emailR.value;
        const userPassword = passwordR.value;
        const userPasswordRepeat = passwordRepit.value;

        if (userPassword.length < 8 || new TextEncoder().encode(userPassword).length > 72) {
            Swal.fire({
                icon: "error",
                title: "Sucedió un error.",
                text: "La contraseña debe tener al menos 8 caracteres y máximo 72 bytes",
            });
            return;
        }

        if (userPassword !== userPasswordRepeat) {
            Swal.fire({
                icon: "error",
                title: "Sucedió un error.",
                text: "Las contraseñas no coinciden!",
            });
            return;
        }

        const userData = {
            name: userName,
            age: Number(userAge),
            email: userEmail,
            password: userPassword,
        };

        const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.REGISTER), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(userData),
        });

        if (response.ok) {
            const data = await response.json();
            
            if (data.token) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('userId', data.user.id);
            }

            Swal.fire({
                icon: "success",
                title: "Se ha registrado con éxito",
                showConfirmButton: false,
                timer: 1500
            });

            setTimeout(function() {
                window.location.href = '/logIn';
            }, 1500);
        } else {
            const errorData = await response.json();
            Swal.fire({
                icon: "error",
                title: "Sucedió un error.",
                text: errorData.error || "No se completó el registro, vuelve a intentarlo!",
            });
        }
    } catch (error) {
        Swal.fire({
            icon: "error",
            title: "Error de conexión",
            text: "No se pudo conectar con el servidor",
        });
    }
});
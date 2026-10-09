const emailLogin = document.getElementById('email');
const passLogin = document.getElementById('password');
const actionLogin = document.getElementById('profiteering');

actionLogin.addEventListener('click', async () => {
    try {
        let email = emailLogin.value;
        let password = passLogin.value;

        if (email === "" || password === "") {
            Swal.fire({
                icon: "error",
                title: "Campos vacíos",
                text: "Por favor ingresa email y contraseña",
            });
            return;
        }

        let credentials = { email, password };

        const response = await fetch(getApiUrl(API_CONFIG.ENDPOINTS.LOGIN), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(credentials),
        });

        if (response.ok) {
            const data = await response.json();
            const token = data.token;
            
            localStorage.setItem('token', token);
            localStorage.setItem('userId', data.user.id);
            
            window.location.href = '/index_logIn';
        } else if (response.status === 429) {
            const errorData = await response.json();
            Swal.fire({
                icon: "error",
                title: "Demasiados intentos",
                text: errorData.error || "Espera un minuto e intenta de nuevo",
            });
        } else {
            Swal.fire({
                icon: "error",
                title: "Salió algo mal",
                text: "Contraseña o correo incorrecto!",
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
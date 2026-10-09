document.addEventListener('DOMContentLoaded', () => {
    loadProfile();
    initializeProfileImageHandlers();
});

function loadProfile() {
    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    const userId = localStorage.getItem('userId');
    
    if (!token || !userId) {
        window.location.href = '/logIn';
        return;
    }
    
    var url = getApiUrl(API_CONFIG.ENDPOINTS.PROFILE);

    xhr.open('GET', url, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    
    xhr.onload = function() {
        if (xhr.status != 200) {
            alert(xhr.status + ': ' + xhr.statusText); 
        } else { 
            if (xhr.status === 200) {
                let usernameField = document.querySelector('#account-input-username');
                let emailField = document.querySelector('#account-input-email');
                let passwordField = document.querySelector('#account-input-password');
                let ageField = document.querySelector('#account-input-age');
                let usernameBoldField = document.querySelector('#account-bold-username');

                let data = JSON.parse(xhr.responseText);
                usernameField.value = data.name;
                usernameField.dataset.prev = data.name;

                // La API nunca regresa la contraseña: el campo solo sirve para escribir una nueva.
                passwordField.value = '';
                passwordField.dataset.prev = '';
                passwordField.placeholder = 'Nueva contraseña';

                emailField.value = data.email;
                emailField.dataset.prev = data.email;

                ageField.innerHTML = data.age + " " + "años";
                usernameBoldField.innerHTML = data.name;
                
                loadProfileImage();
            }
        }
    };
    xhr.send();
}

function confirm(component) {
    let components = getFields(component);
    let field = components[0];
    let confirm = components[1];
    let cancel = components[2];
    let span = components[3];

    field.disabled = true;
    field.classList.add('account-input');
    field.classList.remove('editing');

    span.style.display = 'block';
    confirm.style.display = 'none';
    cancel.style.display = 'none';

    if (updateField(component, field.value)) {
        field.dataset.prev = component === 'password' ? '' : field.value;
    }
    if (component === 'password' || field.value !== field.dataset.prev) {
        field.value = field.dataset.prev;
    }
}

function updateField(field, newValue) {
    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    let ok = false;

    let data = JSON.stringify({ field: field, newValue: newValue });

    xhr.open('PUT', getApiUrl(API_CONFIG.ENDPOINTS.PROFILE), false);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    
    xhr.onload = function() {
        let body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* respuesta vacía */ }
        if (xhr.status !== 200) {
            Swal.fire({ icon: 'error', title: 'No se guardó el cambio', text: body.error || 'Intenta de nuevo' });
            return;
        }
        ok = true;
        document.querySelector('#account-bold-username').innerHTML = body.name;
        document.querySelector('#textProf').innerHTML = body.name;
        if (field === 'password') {
            Swal.fire({ icon: 'success', title: 'Contraseña actualizada', timer: 1500, showConfirmButton: false });
        }
    };
    xhr.send(data);
    return ok;
}

function cancel(component) {
    let components = getFields(component);
    let field = components[0];
    let confirm = components[1];
    let cancel = components[2];
    let span = components[3];

    field.disabled = true;
    field.classList.add('account-input');
    field.classList.remove('editing');

    span.style.display = 'block';
    confirm.style.display = 'none';
    cancel.style.display = 'none';

    field.value = field.dataset.prev;
}

function getFields(component) {
    let field = document.querySelector(`#account-input-${component}`);
    let confirm = document.querySelector(`#account-input-${component}-confirm`);
    let cancel = document.querySelector(`#account-input-${component}-cancel`);
    let span = document.querySelector(`#account-input-${component}-span`);

    let components = [];
    components.push(field);
    components.push(confirm);
    components.push(cancel);
    components.push(span);

    return components;
}

function edit(component) {
    let components = getFields(component);
    let field = components[0];
    let confirm = components[1];
    let cancel = components[2];
    let span = components[3];

    field.disabled = false;
    field.classList.remove('account-input');
    field.classList.add('editing');

    span.style.display = 'none';
    confirm.style.display = 'block';
    cancel.style.display = 'block';
}

function initializeProfileImageHandlers() {
    const fileInput = document.getElementById('profile-image-input');
    const deleteBtn = document.getElementById('delete-profile-image-btn');
    
    fileInput.addEventListener('change', handleProfileImageUpload);
    deleteBtn.addEventListener('click', handleProfileImageDelete);
}

function loadProfileImage() {
    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    
    xhr.open('GET', getApiUrl(API_CONFIG.ENDPOINTS.PROFILE_IMAGE), true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    
    xhr.onload = function() {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.success && data.profileImage) {
                updateProfileImageDisplay(data.profileImage);
                document.getElementById('delete-profile-image-btn').style.display = 'block';
            }
        }
    };
    xhr.send();
}

function handleProfileImageUpload(event) {
    const file = event.target.files[0];
    
    if (!file) return;
    
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!validTypes.includes(file.type)) {
        Swal.fire({
            icon: 'error',
            title: 'Tipo de archivo no permitido',
            text: 'Solo se aceptan imágenes JPEG, JPG, PNG y WEBP'
        });
        event.target.value = '';
        return;
    }
    
    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
        Swal.fire({
            icon: 'error',
            title: 'Archivo demasiado grande',
            text: 'Tamaño máximo: 5MB'
        });
        event.target.value = '';
        return;
    }
    
    uploadProfileImageToServer(file);
}

function uploadProfileImageToServer(file) {
    const formData = new FormData();
    formData.append('profileImage', file);
    
    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    
    xhr.open('POST', getApiUrl(API_CONFIG.ENDPOINTS.PROFILE_UPLOAD), true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    
    xhr.onload = function() {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.success) {
                updateProfileImageDisplay(data.profileImage);
                document.getElementById('delete-profile-image-btn').style.display = 'block';
                Swal.fire({
                    icon: 'success',
                    title: '¡Imagen actualizada!',
                    text: 'Tu imagen de perfil se ha actualizado correctamente',
                    timer: 2000,
                    showConfirmButton: false
                });
            } else {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: data.error
                });
            }
        } else {
            let body = {};
            try { body = JSON.parse(xhr.responseText); } catch (e) { /* respuesta vacía */ }
            Swal.fire({
                icon: 'info',
                title: 'Foto de perfil',
                text: body.error || 'Error al subir la imagen de perfil'
            });
        }
        document.getElementById('profile-image-input').value = '';
    };
    
    xhr.onerror = function() {
        Swal.fire({
            icon: 'error',
            title: 'Error de conexión',
            text: 'No se pudo conectar con el servidor'
        });
        document.getElementById('profile-image-input').value = '';
    };
    
    xhr.send(formData);
}

function handleProfileImageDelete() {
    Swal.fire({
        title: '¿Estás seguro?',
        text: '¿Quieres eliminar tu imagen de perfil?',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d33',
        cancelButtonColor: '#3085d6',
        confirmButtonText: 'Sí, eliminar',
        cancelButtonText: 'Cancelar'
    }).then((result) => {
        if (result.isConfirmed) {
            const xhr = new XMLHttpRequest();
            const token = localStorage.getItem('token');
            
            xhr.open('DELETE', getApiUrl(API_CONFIG.ENDPOINTS.PROFILE_DELETE), true);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            
            xhr.onload = function() {
                if (xhr.status === 200) {
                    const data = JSON.parse(xhr.responseText);
                    if (data.success) {
                        updateProfileImageDisplay('/assets/images/pos.jpg');
                        document.getElementById('delete-profile-image-btn').style.display = 'none';
                        Swal.fire({
                            icon: 'success',
                            title: '¡Eliminada!',
                            text: 'Tu imagen de perfil ha sido eliminada',
                            timer: 2000,
                            showConfirmButton: false
                        });
                    } else {
                        Swal.fire({
                            icon: 'error',
                            title: 'Error',
                            text: data.error
                        });
                    }
                } else {
                    Swal.fire({
                        icon: 'error',
                        title: 'Error',
                        text: 'Error al eliminar la imagen de perfil'
                    });
                }
            };
            
            xhr.onerror = function() {
                Swal.fire({
                    icon: 'error',
                    title: 'Error de conexión',
                    text: 'No se pudo conectar con el servidor'
                });
            };
            
            xhr.send();
        }
    });
}

function updateProfileImageDisplay(imageUrl) {
    const profileImage = document.getElementById('profile-image-display');
    if (profileImage) {
        profileImage.src = imageUrl;
    }
    
    const navProfileImages = document.querySelectorAll('.h-6.w-auto.rounded-full');
    navProfileImages.forEach(img => {
        img.src = imageUrl;
    });
}
// Header profile image functionality
// This script loads and displays the user's profile image in the header btnProf element

function loadHeaderProfileImage() {
    const btnProf = document.getElementById('btnProf');
    if (!btnProf) return;

    const profileImg = btnProf.querySelector('img');
    const textProf = document.getElementById('textProf');
    
    if (!profileImg) return;

    const xhr = new XMLHttpRequest();
    const token = localStorage.getItem('token');
    
    if (!token) {
        console.log('No token found, user not logged in');
        return;
    }
    
    xhr.open('GET', getApiUrl(API_CONFIG.ENDPOINTS.PROFILE_IMAGE), true);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    
    xhr.onload = function() {
        if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.success && data.profileImage) {
                profileImg.src = data.profileImage;
            }
        } else if (xhr.status === 404) {
            // User has no profile image, keep default
            console.log('No profile image found, using default');
        }
    };
    
    xhr.onerror = function() {
        console.error('Error loading profile image');
    };
    
    xhr.send();
}

// Auto-load profile image when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHeaderProfileImage);
} else {
    loadHeaderProfileImage();
}
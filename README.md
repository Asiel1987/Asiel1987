import React, { useState, useEffect } from 'react';
import { View, TextInput, Button, Text } from 'react-native';
import axios from 'axios';
import { GoogleSignin, statusCodes } from '@react-native-community/google-signin';
import { LoginManager, AccessToken } from 'react-native-fbsdk-next';

useEffect(() => {
  GoogleSignin.configure({
    webClientId: 'YOUR_GOOGLE_WEB_CLIENT_ID',
  });
}, []);

const signInWithGoogle = async () => {
  try {
    await GoogleSignin.hasPlayServices();
    const userInfo = await GoogleSignin.signIn();
    // Send userInfo.idToken to your backend
  } catch (error) {
    // Handle errors
  }
};

const signInWithFacebook = async () => {
  try {
    const result = await LoginManager.logInWithPermissions(['public_profile']);
    if (result.isCancelled) {
      // Handle cancellation
    } else {
      const data = await AccessToken.getCurrentAccessToken();
      // Send data.accessToken to your backend
    }
  } catch (error) {
    // Handle errors
  }
};

function LoginScreen({ navigation }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = async () => {
    try {
      const response = await axios.post('http://localhost:3000/auth/login', { username, password });
      const { token } = response.data;
      // Save token and navigate to protected route
    } catch (error) {
      setError('Invalid credentials');
    }
  };

  return (
    <View>
      <TextInput placeholder="Username" value={username} onChangeText={setUsername} />
      <TextInput placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      {error ? <Text>{error}</Text> : null}
      <Button title="Login" onPress={handleLogin} />
      <Button title="Sign in with Google" onPress={signInWithGoogle} />
      <Button title="Sign in with Facebook" onPress={signInWithFacebook} />
    </View>
  );
}

export default LoginScreen;
- 👋 Hi, I’m @Asiel1987
- 👀 I’m interested in ...
- 🌱 I’m currently learning ...
- 💞️ I’m looking to collaborate on ...
- 📫 How to reach me ...
- 😄 Pronouns: ...
- ⚡ Fun fact: ...

<!---
Asiel1987/Asiel1987 is a ✨ special ✨ repository because its `README.md` (this file) appears on your GitHub profile.
You can click the Preview link to take a look at your changes.
--->

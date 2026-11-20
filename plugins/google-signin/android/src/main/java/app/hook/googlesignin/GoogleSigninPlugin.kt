package app.hook.googlesignin

import android.app.Activity
import android.util.Log
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * The phone's own account sheet.
 *
 * `GetGoogleIdOption` asks Credential Manager for an ID token issued by Google
 * for `serverClientId` — the web client id the server fetches from its own
 * config — and Android answers with whichever Google account the person picks.
 * The token is short-lived, names our client as its audience, and can only be
 * obtained by an app signed with the registered package name and certificate;
 * the server checks all of that before it becomes a session.
 *
 * There is no browser here, and nothing to come back to: the sheet closes and
 * the answer is the token.
 */
@TauriPlugin
class GoogleSigninPlugin(private val activity: Activity) : Plugin(activity) {
    private val scope = CoroutineScope(Dispatchers.Main)

    private companion object {
        const val TAG = "HookGoogleSignin"
    }

    /** A phone with Play services can show the sheet; that is the only test. */
    @Command
    fun available(invoke: Invoke) {
        val result = JSObject()
        result.put("google", true)
        invoke.resolve(result)
    }

    @Command
    fun signIn(invoke: Invoke) {
        val args = invoke.parseArgs(SignInArgs::class.java)
        scope.launch {
            try {
                val option =
                    GetGoogleIdOption.Builder()
                        .setServerClientId(args.serverClientId)
                        // Show every account on the device, not only ones this
                        // app already used: a fresh install has none.
                        .setFilterByAuthorizedAccounts(false)
                        .setAutoSelectEnabled(false)
                        .build()
                val request =
                    GetCredentialRequest.Builder()
                        .addCredentialOption(option)
                        .build()
                val response = CredentialManager.create(activity).getCredential(activity, request)
                val credential = response.credential
                if (credential.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                    Log.e(TAG, "unexpected credential type: ${credential.type}")
                    invoke.reject("The account sheet returned an unexpected credential.", "failed")
                    return@launch
                }
                val google = GoogleIdTokenCredential.createFrom(credential.data)
                val result = JSObject()
                result.put("idToken", google.idToken)
                Log.i(TAG, "account sheet returned an id token")
                invoke.resolve(result)
            } catch (error: GetCredentialCancellationException) {
                Log.i(TAG, "the sheet was dismissed")
                invoke.reject("Sign-in was cancelled.", "cancelled")
            } catch (error: GetCredentialException) {
                Log.e(TAG, "the sheet failed: ${error.javaClass.simpleName}: ${error.message}")
                invoke.reject(error.message ?: "Google sign-in failed.", "failed")
            } catch (error: Exception) {
                Log.e(TAG, "the exchange with Google failed: ${error.javaClass.simpleName}: ${error.message}")
                invoke.reject(error.message ?: "Google sign-in failed.", "failed")
            }
        }
    }
}

@InvokeArg
class SignInArgs {
    lateinit var serverClientId: String
}

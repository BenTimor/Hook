## Default Permission

Sign in with the phone's own Google account sheet. The sheet returns a Google
ID token; the server decides whether that token belongs to an approved account.

#### This default permission set includes the following:

- `allow-available`
- `allow-sign-in`

## Permission Table

<table>
<tr>
<th>Identifier</th>
<th>Description</th>
</tr>


<tr>
<td>

`google-signin:allow-available`

</td>
<td>

Enables the available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`google-signin:deny-available`

</td>
<td>

Denies the available command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`google-signin:allow-sign-in`

</td>
<td>

Enables the sign_in command without any pre-configured scope.

</td>
</tr>

<tr>
<td>

`google-signin:deny-sign-in`

</td>
<td>

Denies the sign_in command without any pre-configured scope.

</td>
</tr>
</table>
